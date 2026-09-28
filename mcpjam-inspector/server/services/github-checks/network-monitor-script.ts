/**
 * Passive Linux packet-header observer. No pcap files, payload decoding, DNS
 * names, or request text. Runs outside the checkout, before any repository code.
 * Guest root can disable or spoof it: these are diagnostics, not firewall audit.
 */
export const NETWORK_MONITOR_SCRIPT = String.raw`
import collections
import json
import signal
import socket
import struct
import time

MAX_PENDING = 512
WINDOW_LIMIT = 120
TOTAL_LIMIT = 2000
TIMEOUT = 10

def decode(packet, quoted=False):
    if not packet:
        return None
    version = packet[0] >> 4
    if version == 4:
        if len(packet) < 20:
            return None
        offset = (packet[0] & 15) * 4
        if offset < 20 or len(packet) < offset or struct.unpack('!H', packet[6:8])[0] & 8191:
            return None
        proto = packet[9]
        src = socket.inet_ntop(socket.AF_INET, packet[12:16])
        dst = socket.inet_ntop(socket.AF_INET, packet[16:20])
    elif version == 6:
        if len(packet) < 40:
            return None
        src = socket.inet_ntop(socket.AF_INET6, packet[8:24])
        dst = socket.inet_ntop(socket.AF_INET6, packet[24:40])
        proto, offset = packet[6], 40
        for _ in range(6):
            if proto not in (0, 43, 44, 51, 60):
                break
            if len(packet) < offset + 8:
                return None
            if proto == 44:
                if struct.unpack('!H', packet[offset+2:offset+4])[0] & 65528:
                    return None
                size = 8
            else:
                size = (packet[offset+1] + (2 if proto == 51 else 1)) * (4 if proto == 51 else 8)
            proto, offset = packet[offset], offset + size
    else:
        return None
    if proto in (6, 17):
        needed = 4 if quoted else (20 if proto == 6 else 8)
        if len(packet) < offset + needed:
            return None
        sport, dport = struct.unpack('!HH', packet[offset:offset+4])
        flags = packet[offset+13] if proto == 6 and not quoted else 0
        return (version, proto, src, dst, sport, dport, flags, None)
    if proto in (1, 58) and len(packet) >= offset + 8:
        # Only ICMP unreachable responses; decode the quoted IP + transport
        # headers, never their body. Short/truncated quotes are ignored.
        if packet[offset] == (3 if proto == 1 else 1):
            return (version, proto, src, dst, 0, 0, 0, packet[offset+8:])
    return None

class Observer:
    def __init__(self, emit):
        self.emit = emit
        self.pending = collections.OrderedDict()
        self.established = collections.OrderedDict()

    def event(self, p, outcome, reverse=False):
        version, proto, src, dst, sport, dport, flags, quote = p
        self.emit({'kind': 'connection', 'family': version,
                   'protocol': 'tcp' if proto == 6 else 'udp',
                   'destinationIp': src if reverse else dst,
                   'destinationPort': sport if reverse else dport,
                   'outcome': outcome, 'timestamp': int(time.time() * 1000)})

    def observe(self, packet, outgoing, now):
        p = decode(packet)
        if p is None:
            return
        version, proto, src, dst, sport, dport, flags, quote = p
        if quote is not None:
            original = decode(quote, quoted=True)
            if not outgoing and original and original[1] in (6, 17):
                self.pending.pop((original[2], original[4], original[3], original[5]), None)
                self.event(original, 'unreachable_observed')
            return
        key = (src, sport, dst, dport)
        if outgoing and proto == 17:
            self.event(p, 'attempted')
        elif outgoing and proto == 6 and flags & 2 and not flags & 16:
            if key not in self.pending:
                if len(self.pending) >= MAX_PENDING:
                    self.pending.popitem(last=False)
                    self.emit({'kind': 'dropped', 'count': 1})
                self.pending[key] = (now, p)
                self.event(p, 'attempted')
        elif not outgoing and proto == 6:
            reverse = (dst, dport, src, sport)
            if reverse in self.pending and (flags & 4 or flags & 18 == 18):
                self.pending.pop(reverse)
                self.event(p, 'reset_observed' if flags & 4 else 'syn_ack_observed', True)
                if not flags & 4:
                    if len(self.established) >= MAX_PENDING:
                        self.established.popitem(last=False)
                        self.emit({'kind': 'dropped', 'count': 1})
                    self.established[reverse] = now
            elif reverse in self.established and flags & 4:
                self.established.pop(reverse)
                self.event(p, 'reset_observed', True)
            if flags & 1:
                self.established.pop(reverse, None)

    def expire(self, now):
        for key, started in list(self.established.items()):
            if now - started >= 300:
                self.established.pop(key)
        for key, (started, packet) in list(self.pending.items()):
            if now - started >= TIMEOUT:
                self.pending.pop(key)
                self.event(packet, 'timeout_inferred')

def main():
    running = True
    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    def output(row):
        print(json.dumps(row, separators=(',', ':')), flush=True)
    window_start = time.monotonic()
    window_count = total = dropped = 0
    def emit(row):
        nonlocal window_start, window_count, total, dropped
        if row['kind'] == 'dropped':
            dropped += row['count']
            return
        now = time.monotonic()
        if now - window_start >= 60:
            window_start, window_count = now, 0
        if window_count >= WINDOW_LIMIT or total >= TOTAL_LIMIT:
            dropped += 1
            return
        window_count += 1
        total += 1
        output(row)
    # SOCK_DGRAM excludes Ethernet headers. Capture only a bounded prefix in
    # memory, and emit only the typed network fields above.
    sock = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(3))
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
    sock.settimeout(0.5)
    observer = Observer(emit)
    output({'kind': 'ready'})
    last_tick = last_expiry = time.monotonic()
    deadline = last_tick + 45 * 60
    packet_window, packet_count = last_tick, 0
    try:
        while running and time.monotonic() < deadline:
            now = time.monotonic()
            if now - packet_window >= 1:
                packet_window, packet_count = now, 0
            if packet_count >= 2000:
                # Bound CPU work during a packet flood; socket-overflow losses
                # are reported at the next heartbeat.
                time.sleep(max(0, 1 - (now - packet_window)))
                continue
            try:
                packet, address = sock.recvfrom(128)
                packet_count += 1
                if address[0] != 'lo':
                    observer.observe(packet, address[2] == 4, time.monotonic())
            except socket.timeout:
                pass
            now = time.monotonic()
            if now - last_expiry >= 1:
                observer.expire(now)
                last_expiry = now
            if now - last_tick >= 10:
                # Linux resets this counter on read. Include socket-overflow
                # losses, not just the monitor's own rate-limit drops.
                _, kernel_drops = struct.unpack('II', sock.getsockopt(263, 6, 8))
                output({'kind': 'heartbeat', 'dropped': dropped + kernel_drops})
                dropped = 0
                last_tick = now
    finally:
        sock.close()
        output({'kind': 'stopped', 'dropped': dropped})

if __name__ == '__main__':
    main()
`;
