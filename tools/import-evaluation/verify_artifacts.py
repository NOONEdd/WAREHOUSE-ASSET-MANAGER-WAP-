"""O-13 acceptance check: verifies the installed packages against the published
artifacts. The tarball of every lockfile entry is downloaded (npm pack), its SHA-512
is computed here and compared with the lockfile's integrity value, and every file in
the tarball is compared byte for byte with the installed copy in node_modules.
Licence evidence is read from the installed files; nothing is changed or suppressed.
Run after `npm ci --ignore-scripts`, and again after any dependency change:
    python3 -I verify_artifacts.py PROJECT_DIR EMPTY_WORK_DIR PATH_TO_NPM
The downloaded tarballs are untrusted data: they are only hashed and unpacked (with
tarfile's "data" filter) into the work folder, never executed.
"""
import base64, hashlib, json, os, subprocess, sys, tarfile

project, work, npm = sys.argv[1], sys.argv[2], sys.argv[3]
if os.path.exists(work) and os.listdir(work):
    sys.exit('the work folder must be empty or absent')
for sub in ('tarballs', 'extract', 'npmcwd'):
    os.makedirs(os.path.join(work, sub), exist_ok=True)
lock = json.load(open(os.path.join(project, 'package-lock.json')))['packages']
entries = []
for path, e in lock.items():
    if not path:
        continue
    name = e.get('name') or path.split('node_modules/')[-1]
    entries.append({'path': path, 'name': name, 'version': e['version'], 'resolved': e['resolved'], 'integrity': e['integrity'], 'license': e.get('license')})

tar_dir = os.path.join(work, 'tarballs')
specs = sorted({f"{x['name']}@{x['version']}" for x in entries})
r = subprocess.run([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', tar_dir, *specs],
                   cwd=os.path.join(work, 'npmcwd'), capture_output=True, text=True)
if r.returncode != 0:
    print(r.stderr[-2000:]); sys.exit(2)
packed = {f"{p['name']}@{p['version']}": os.path.join(tar_dir, p['filename']) for p in json.loads(r.stdout)}

LICENCE_FILES = ('license', 'licence', 'copying', 'unlicense')
problems, rows = [], []
for i, x in enumerate(entries):
    spec = f"{x['name']}@{x['version']}"
    tgz = packed[spec]
    data = open(tgz, 'rb').read()
    algo, want = x['integrity'].split('-', 1)
    got = base64.b64encode(hashlib.new(algo, data).digest()).decode()
    integrity_ok = algo == 'sha512' and got == want
    url_ok = x['resolved'].endswith('/' + os.path.basename(x['resolved'])) and x['resolved'].startswith('https://registry.npmjs.org/')
    out = os.path.join(work, 'extract', str(i))
    os.makedirs(out)
    with tarfile.open(tgz, 'r:gz') as t:
        members = [m for m in t.getmembers() if m.isfile()]
        t.extractall(out, members=members, filter='data')
    tops = {m.name.split('/', 1)[0] for m in members}
    root = os.path.join(out, tops.pop()) if len(tops) == 1 else out
    installed = os.path.join(project, x['path'])
    mismatched, missing = [], []
    files = 0
    for d, _, fs in os.walk(root):
        for f in fs:
            src = os.path.join(d, f)
            rel = os.path.relpath(src, root)
            dst = os.path.join(installed, rel)
            files += 1
            if not os.path.isfile(dst):
                missing.append(rel)
            elif open(src, 'rb').read() != open(dst, 'rb').read():
                mismatched.append(rel)
    extra = []
    for d, dirs, fs in os.walk(installed):
        dirs[:] = [k for k in dirs if k != 'node_modules']
        for f in fs:
            rel = os.path.relpath(os.path.join(d, f), installed)
            if not os.path.isfile(os.path.join(root, rel)):
                extra.append(rel)
    pkg = json.load(open(os.path.join(installed, 'package.json')))
    lic_field = pkg.get('license') or pkg.get('licenses')
    lic_files = sorted(f for f in os.listdir(installed) if f.lower().startswith(LICENCE_FILES))
    readme_lic = ''
    if not lic_files:
        for f in os.listdir(installed):
            if f.lower().startswith('readme'):
                txt = open(os.path.join(installed, f), encoding='utf-8', errors='replace').read()
                if 'Permission is hereby granted' in txt or 'Permission to use, copy, modify' in txt:
                    readme_lic = f
    row = {'package': spec, 'path': x['path'], 'integrity': integrity_ok, 'registryUrl': url_ok, 'files': files,
           'mismatched': mismatched, 'missingInInstall': missing, 'extraInInstall': extra,
           'licenseField': lic_field, 'lockLicense': x['license'], 'licenseFiles': lic_files, 'licenceTextInReadme': readme_lic}
    rows.append(row)
    if not integrity_ok or not url_ok or mismatched or missing or extra:
        problems.append(row)

json.dump(rows, open(os.path.join(work, 'artifact-report.json'), 'w'), indent=1)
print(f"entries {len(entries)}; tarballs {len(packed)}; files compared {sum(r['files'] for r in rows)}")
print(f"integrity (sha512 recomputed) equal to lockfile: {sum(r['integrity'] for r in rows)}/{len(rows)}")
print(f"tarball contents identical to installed files (no mismatch, missing or extra): {len(rows) - len([r for r in rows if r['mismatched'] or r['missingInInstall'] or r['extraInInstall']])}/{len(rows)}")
print(f"licence field present: {sum(1 for r in rows if r['licenseField'])}/{len(rows)}; field equals lockfile: {sum(1 for r in rows if r['licenseField'] == r['lockLicense'])}/{len(rows)}")
print('no licence file:', [(r['package'], r['licenseField'], r['licenceTextInReadme'] or 'no licence text in README') for r in rows if not r['licenseFiles']])
from collections import Counter
print('licences:', dict(Counter(str(r['licenseField']) for r in rows)))
for p in problems:
    print('PROBLEM', json.dumps(p)[:400])
sys.exit(1 if problems else 0)
