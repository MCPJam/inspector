"""Post-trial allowlisted task metadata; never native agent configuration/auth."""
import hashlib
import json
from pathlib import Path

FILES = ['instruction.md', 'task.toml', 'manifest.json', 'environment/Dockerfile',
         'environment/docker-compose.yaml', 'steps/blocked/instruction.md', 'steps/resume/instruction.md',
         'tests/Dockerfile', 'tests/prompt.txt']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def publish_task_metadata(jobs, out, public_object, redact):
    root = out / 'task-metadata'
    root.mkdir(exist_ok=True)
    entries = []
    for published in sorted(out.glob('*/summary.json')):
        summary = json.loads(published.read_text())
        run_id = summary['run_id']
        trial_name = run_id.removeprefix(summary['job'] + '--')
        result_path = jobs / summary['job'] / trial_name / 'result.json'
        result = json.loads(result_path.read_text()) if result_path.exists() else {}
        config = (result.get('config') or {}).get('task') or {}
        task = Path(config['path']) if config.get('path') else None
        entry = {'run_id': run_id, 'harbor_task_checksum': result.get('task_checksum'), 'metadata': None}
        if task is None or not task.is_dir():
            entry['limitation'] = 'Original task directory unavailable; no task contents reconstructed.'
            entries.append(entry)
            continue
        manifest_path = task / 'manifest.json'
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        source_files = {name: (task / name).read_bytes() for name in FILES if (task / name).is_file()}
        raw_hashes = {name: sha(data) for name, data in source_files.items()}
        snapshot_id = sha(json.dumps(raw_hashes, sort_keys=True).encode())[:20]
        target = root / snapshot_id
        verified = {name: raw_hashes[name] == manifest[name] for name in raw_hashes if name in manifest}
        if not target.exists():
            target.mkdir()
            files = []
            for name, data in source_files.items():
                # Compose is generated as JSON; object sanitization covers secret keys.
                if name.endswith(('.json', '.yaml')):
                    try:
                        text = json.dumps(public_object(json.loads(data)), indent=2)
                    except ValueError:
                        text = redact(data.decode(errors='replace'))
                else:
                    text = redact(data.decode(errors='replace'))
                destination = target / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(text)
                files.append({'path': name, 'original_sha256': raw_hashes[name], 'sanitized_sha256': sha(text.encode()),
                              'matches_recorded_manifest': verified.get(name)})
            record = {'files': files, 'source_files_verified_against_recorded_manifest': bool(verified) and all(verified.values()),
                      'scope': 'Allowlisted task instructions, task config, environment definitions, verifier-image packaging and recorded file-hash manifest. Published after tester completion; excludes native agent/auth/config stores and package archives.',
                      'redaction_note': 'Published configuration contains redactions, including synthetic credentials and host identity. Original and sanitized hashes are separate. Original hashes authenticate local task bytes, not sanitized bytes.'}
            (target / 'metadata.json').write_text(json.dumps(record, indent=2))
            (target / 'index.md').write_text('# Task snapshot\n\n[Metadata and original/sanitized hashes](metadata.json)\n\n' + '\n'.join(f'- [{name}]({name})' for name in source_files) + '\n')
        entry.update({'metadata': snapshot_id + '/index.md', 'source_files_verified_against_recorded_manifest': bool(verified) and all(verified.values())})
        entries.append(entry)
    (root / 'runs.json').write_text(json.dumps(entries, indent=2))
    lines = ['# Task configuration and instruction evidence', '',
             'Post-trial publication of allowlisted task definitions. Existing run evidence remains immutable. Snapshots are deduplicated by original allowlisted file hashes; credentials and host identity are sanitized. A missing source is reported, never reconstructed.', '',
             '[Per-run mapping and recorded Harbor task checksums](runs.json)', '', '| Run | Task snapshot | Matches recorded manifest |', '| --- | --- | --- |']
    for entry in entries:
        link = f"[Snapshot]({entry['metadata']})" if entry['metadata'] else entry['limitation']
        lines.append(f"| [{entry['run_id']}](../{entry['run_id']}/index.md) | {link} | {entry.get('source_files_verified_against_recorded_manifest', 'unknown')} |")
    (root / 'index.md').write_text('\n'.join(lines) + '\n')
    return entries
