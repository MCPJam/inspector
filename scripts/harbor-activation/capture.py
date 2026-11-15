"""Capture subprocess outcomes before any evaluation installation or discovery.

Bootstrap recorder; promoted into the suite after repository inspection.
"""
import argparse, datetime, html, json, os, pathlib, re, selectors, signal, subprocess, time

def redact(text):
    for key, value in os.environ.items():
        if re.search(r'TOKEN|SECRET|PASSWORD|API_KEY', key) and len(value) >= 8:
            text = text.replace(value, '[REDACTED]')
    text = re.sub(r'(?i)(bearer\s+)[\w.\-]+', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)([?&](?:token|key|secret|code)=)[^\s&\"]+', r'\1[REDACTED]', text)
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[EMAIL REDACTED]', text)
    return text.replace(str(pathlib.Path.home()), '$USER_HOME')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True)
    parser.add_argument('--out', default='outputs/evidence/bootstrap')
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    directory = pathlib.Path(args.out) / args.id
    directory.mkdir(parents=True, exist_ok=False)
    start = time.time()
    meta = {'event_id': args.id, 'role': 'orchestrator', 'argv': command, 'cwd': os.getcwd(),
            'start': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'environment': {k: os.environ[k] for k in ['PATH','HOME','DOCKER_HOST','UV_CACHE_DIR','npm_config_cache'] if k in os.environ},
            'capture': 'separate pipes; chunks ordered by recorder observation, not kernel total order',
            'timeout_seconds': args.timeout}
    streams = {'stdout': bytearray(), 'stderr': bytearray()}
    events = []
    try:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        selector = selectors.DefaultSelector()
        for name, stream in [('stdout',proc.stdout),('stderr',proc.stderr)]:
            selector.register(stream, selectors.EVENT_READ, name)
        timed_out = False
        while selector.get_map():
            if time.time() - start > args.timeout and not timed_out:
                os.killpg(proc.pid, signal.SIGKILL)
                timed_out = True
            for key, _ in selector.select(.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    streams[key.data].extend(chunk)
                    events.append({'seconds': time.time()-start, 'stream': key.data, 'data': chunk.decode('utf-8','replace')})
        meta.update(exit_status=proc.wait(), timed_out=timed_out)
    except OSError as error:
        streams['stderr'].extend(str(error).encode())
        meta.update(exit_status=127, timed_out=False, classification='harness_error')
    meta.update(end=datetime.datetime.now(datetime.timezone.utc).isoformat(), duration_seconds=time.time()-start)
    for name, value in streams.items():
        (directory / (name+'.txt')).write_text(redact(value.decode('utf-8','replace')))
    (directory/'event.json').write_text(redact(json.dumps(meta, indent=2)))
    (directory/'stream.jsonl').write_text('\n'.join(redact(json.dumps(e)) for e in events)+'\n')
    text = '$ ' + ' '.join(command) + '\n' + ''.join(e['data'] for e in events)
    text += f'\n[exit={meta["exit_status"]}; timeout={meta["timed_out"]}]'
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', redact(text)).replace('\r','\n')
    lines = [piece for line in text.splitlines() for piece in ([line[i:i+130] for i in range(0,len(line),130)] or [''])]
    for page, offset in enumerate(range(0,len(lines),70),1):
        rows=lines[offset:offset+70]
        svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="%d"><rect width="100%%" height="100%%" fill="#101820"/><g font-family="monospace" font-size="14" fill="#e8edf2">' % (70+len(rows)*20)
        svg+='<text x="20" y="25" fill="#86d9c4">Rendered evidence from captured output — '+html.escape(args.id)+f' — page {page}</text>'
        svg+=''.join(f'<text x="20" y="{55+i*20}">{html.escape(line)}</text>' for i,line in enumerate(rows))+'</g></svg>'
        (directory/f'output-{page:03}.svg').write_text(svg)
    print(json.dumps({'event_id':args.id,'exit_status':meta['exit_status'],'seconds':round(meta['duration_seconds'],2),'output':str(directory)}))
    print(redact(streams['stdout'].decode('utf-8','replace'))[-8000:])
    print(redact(streams['stderr'].decode('utf-8','replace'))[-3000:])
    return meta['exit_status'] if meta['exit_status'] >= 0 else 128-meta['exit_status']

if __name__ == '__main__':
    raise SystemExit(main())
