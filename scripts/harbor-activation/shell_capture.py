#!/usr/bin/python3
"""Record actual shell invocations, including output absent from agent transcripts."""
import datetime
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time
import uuid


def main():
    root = Path('/capture')
    root.mkdir(exist_ok=True)
    event_id = uuid.uuid4().hex
    start = time.time()
    directory = root / event_id
    directory.mkdir()
    meta = {'event_id': event_id, 'argv': ['/bin/bash', *sys.argv[1:]],
            'cwd': os.getcwd(), 'start': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'environment': {k: os.environ[k] for k in ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'MCPJAM_API_URL'] if k in os.environ},
            'capture': 'separate pipes; read-observation ordering; noninteractive'}
    (directory / 'event.json').write_text(json.dumps(meta))
    process = subprocess.Popen(['/bin/bash.real', *sys.argv[1:]], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, ('stdout', 1))
    selector.register(process.stderr, selectors.EVENT_READ, ('stderr', 2))
    with (directory / 'stdout.txt').open('wb') as out, (directory / 'stderr.txt').open('wb') as err, (directory / 'stream.jsonl').open('w') as ordered:
        outputs = {'stdout': out, 'stderr': err}
        while selector.get_map():
            for key, _ in selector.select():
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                name, fd = key.data
                outputs[name].write(chunk)
                outputs[name].flush()
                ordered.write(json.dumps({'seconds': time.time()-start, 'stream': name, 'data': chunk.decode('utf-8', 'replace')})+'\n')
                ordered.flush()
                os.write(fd, chunk)
    code = process.wait()
    meta.update(exit_status=code, signal=-code if code < 0 else None,
                duration_seconds=time.time()-start, end=datetime.datetime.now(datetime.timezone.utc).isoformat())
    (directory / 'event.json').write_text(json.dumps(meta, indent=2))
    return code if code >= 0 else 128-code


if __name__ == '__main__':
    raise SystemExit(main())
