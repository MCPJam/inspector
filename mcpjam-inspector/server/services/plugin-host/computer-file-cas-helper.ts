import { PLUGIN_FILE_MAX_BYTES } from "../../../shared/plugin-file-transfer.js";

/** Fixed VM program. Request metadata travels separately; file bytes use the filesystem API. */
export const COMPUTER_FILE_CAS_PYTHON = String.raw`
import base64, errno, fcntl, hashlib, json, os, re, stat

HOME = "/home/user"
NOFOLLOW = os.O_NOFOLLOW
DIRECTORY = os.O_DIRECTORY

class Refusal(Exception):
    def __init__(self, outcome): self.outcome = outcome

def refuse(outcome="denied"):
    raise Refusal(outcome)

def directory(path):
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        refuse()
    fd = os.open("/", os.O_RDONLY | DIRECTORY)
    try:
        for part in path.split("/")[1:]:
            if not part: refuse()
            next_fd = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def bound(request):
    root, path = request["root"], request["path"]
    if not isinstance(root, str) or not isinstance(path, str): refuse()
    if root != HOME and not root.startswith(HOME + "/"): refuse()
    if not path.startswith(root + "/") or len(path) > 1024 or "\x00" in path: refuse()
    if os.path.normpath(root) != root or os.path.normpath(path) != path: refuse()
    root_fd = directory(root)
    os.close(root_fd)
    return directory(os.path.dirname(path)), os.path.basename(path)

def identity(info): return [str(info.st_dev), str(info.st_ino)]

def private(info):
    return info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_ISREG(info.st_mode)

def stage_open(parent, request):
    name = ".mcpjam-cas-" + request["stageId"]
    if not re.fullmatch(r"[a-f0-9]{32}", request["stageId"]): refuse()
    fd = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent)
    info = os.fstat(fd)
    if identity(info) != request["directoryIdentity"] or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        refuse()
    return fd, name

def read_file(fd, maximum):
    data = bytearray()
    while True:
        chunk = os.read(fd, min(65536, maximum + 1 - len(data)))
        if not chunk: break
        data.extend(chunk)
        if len(data) > maximum: refuse("too-large")
    return bytes(data)

def stage_bytes(fd, request):
    info = os.fstat(fd)
    if not private(info) or identity(info) != request["fileIdentity"]: refuse()
    data = read_file(fd, request["maxBytes"])
    if len(data) != request["size"] or hashlib.sha256(data).hexdigest() != request["sha256"]: refuse()
    return info

def lock_target(parent, path):
    name = ".mcpjam-cas-lock-" + hashlib.sha256(path.encode()).hexdigest()
    fd = os.open(name, os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600, dir_fd=parent)
    info = os.fstat(fd)
    if not private(info) or info.st_mode & 0o077:
        os.close(fd)
        refuse()
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd

def cleanup(parent, request):
    lock = lock_target(parent, request["path"])
    try: cleanup_locked(parent, request)
    finally: os.close(lock)

def cleanup_locked(parent, request):
    stage, name = stage_open(parent, request)
    try:
        try:
            info = os.stat("payload", dir_fd=stage, follow_symlinks=False)
            if not private(info) or identity(info) != request["fileIdentity"]: refuse()
            os.unlink("payload", dir_fd=stage)
        except FileNotFoundError:
            pass
        if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != request["directoryIdentity"]: refuse()
        os.rmdir(name, dir_fd=parent)
    finally:
        os.close(stage)

def main(request):
    if request == {"op": "probe"}:
        if not all(fn in os.supports_dir_fd for fn in [os.open, os.stat, os.unlink, os.mkdir, os.rmdir, os.rename]): refuse("unavailable")
        return {"outcome": "ready"}
    parent, target = bound(request)
    try:
        if request["op"] == "stage":
            if not re.fullmatch(r"[a-f0-9]{32}", request["stageId"]): refuse()
            name = ".mcpjam-cas-" + request["stageId"]
            os.mkdir(name, mode=0o700, dir_fd=parent)
            stage = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent)
            try:
                payload = os.open("payload", os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=stage)
                try:
                    return {"outcome": "staged", "directoryIdentity": identity(os.fstat(stage)), "fileIdentity": identity(os.fstat(payload))}
                finally: os.close(payload)
            finally: os.close(stage)
        if request["op"] == "cleanup":
            cleanup(parent, request)
            return {"outcome": "cleaned"}
        if request["op"] not in ["verify", "commit"]: refuse()
        if type(request["maxBytes"]) is not int or type(request["size"]) is not int or not 0 <= request["size"] <= request["maxBytes"] <= ${PLUGIN_FILE_MAX_BYTES}: refuse()
        if not re.fullmatch(r"[a-f0-9]{64}", request["sha256"]): refuse()
        stage, name = stage_open(parent, request)
        payload = os.open("payload", os.O_RDONLY | NOFOLLOW, dir_fd=stage)
        try:
            if request["op"] == "verify":
                stage_bytes(payload, request)
                return {"outcome": "ready"}
            if not re.fullmatch(r"[a-f0-9]{64}", request["expectedEtag"]): refuse()
            lock = lock_target(parent, request["path"])
            try:
                info = stage_bytes(payload, request)
                current = os.open(target, os.O_RDONLY | NOFOLLOW, dir_fd=parent)
                try:
                    before = os.fstat(current)
                    if not private(before): refuse()
                    etag = hashlib.sha256(read_file(current, request["maxBytes"])).hexdigest()
                    if etag != request["expectedEtag"]: return {"outcome": "conflict", "etag": etag}
                    latest = os.stat(target, dir_fd=parent, follow_symlinks=False)
                    if not private(latest) or identity(latest) != identity(before) or latest.st_mtime_ns != before.st_mtime_ns or latest.st_size != before.st_size: refuse()
                    os.fchmod(payload, stat.S_IMODE(before.st_mode))
                    os.fsync(payload)
                    staged_now = os.stat("payload", dir_fd=stage, follow_symlinks=False)
                    if identity(staged_now) != identity(info) or staged_now.st_size != info.st_size or staged_now.st_mtime_ns != info.st_mtime_ns: refuse()
                    parent_now = directory(os.path.dirname(request["path"]))
                    try:
                        if identity(os.fstat(parent_now)) != identity(os.fstat(parent)): refuse()
                    finally: os.close(parent_now)
                    os.replace("payload", target, src_dir_fd=stage, dst_dir_fd=parent)
                    os.fsync(parent)
                    return {"outcome": "saved", "etag": request["sha256"]}
                finally: os.close(current)
            finally: os.close(lock)
        finally:
            os.close(payload)
            os.close(stage)
    finally: os.close(parent)

try:
    encoded = os.environ.get("MCPJAM_FILE_CAS", "")
    if len(encoded) > 16384: refuse()
    request = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    result = main(request)
except Refusal as error:
    result = {"outcome": error.outcome}
except OSError as error:
    result = {"outcome": "denied" if error.errno in [errno.ELOOP, errno.ENOTDIR, errno.ENOENT] else "unavailable"}
except (ValueError, KeyError, TypeError):
    result = {"outcome": "unavailable"}
print(json.dumps(result, separators=(",", ":")))
`;

/** No request value is interpolated into this shell command. */
export const COMPUTER_FILE_CAS_COMMAND =
  `python3 -c '${COMPUTER_FILE_CAS_PYTHON.replace(/'/g, `'"'"'`)}'`;
