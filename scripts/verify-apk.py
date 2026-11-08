"""Check the release artifact rather than trusting a successful Gradle task."""
import argparse
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('apk', type=Path)
parser.add_argument('--sdk', type=Path, default=Path(os.environ.get('ANDROID_HOME', '')))
parser.add_argument('--certificate', required=True, help='Expected public signer SHA-256')
parser.add_argument('--version', required=True)
args = parser.parse_args()
tools = args.sdk / 'build-tools' / '36.0.0'
suffix = '.bat' if os.name == 'nt' else ''

def run(name, *values):
    return subprocess.check_output([str(tools / (name + (suffix if name == 'apksigner' else '.exe' if os.name == 'nt' else ''))), *map(str, values)], text=True, stderr=subprocess.STDOUT)

assert args.apk.is_file(), 'Missing APK'
signature = run('apksigner', 'verify', '--verbose', '--print-certs', args.apk)
assert 'Verifies' in signature, 'Signature verification failed'
fingerprints = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)', signature)
normalize = lambda value: value.replace(':', '').lower()
assert len(fingerprints) == 1 and normalize(fingerprints[0]) == normalize(args.certificate), 'Unexpected signing identity'
run('zipalign', '-c', '-P', '16', '4', args.apk)
info = run('aapt', 'dump', 'badging', args.apk)
assert "name='app.mavyn.desktop'" in info, 'Wrong package'
assert f"versionName='{args.version}'" in info, 'Wrong version'
assert 'application-debuggable' not in info, 'Debug APK cannot be released'
assert "sdkVersion:'24'" in info, 'Wrong minimum SDK'
print(f'Verified signed non-debuggable {args.apk.name}; version {args.version}; signer SHA-256 {fingerprints[0]}')
