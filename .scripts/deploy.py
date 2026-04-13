"""
deploy.py — Mac → Win 部署脚本
位置：vision-platform/.scripts/deploy.py

用法：
  python3 .scripts/deploy.py          # 只传 UI/api 文件到容器
  python3 .scripts/deploy.py pull     # git pull on Win + 传文件 + docker restart
  python3 .scripts/deploy.py restart  # 传文件 + docker restart
"""
import subprocess, os, sys

KEY   = os.path.expanduser('~/.ssh/id_ed25519')
HOST  = 'spade@192.168.50.71'
BASE  = os.path.join(os.path.dirname(__file__), '..', 'vision-inference')
BASE  = os.path.normpath(BASE)
TOKEN = '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'
REPO  = f'https://{TOKEN}@github.com/wenlei/vision-platform'

MODE = sys.argv[1] if len(sys.argv) > 1 else 'deploy'

def ssh(cmd, timeout=60):
    r = subprocess.run(
        ['ssh', '-i', KEY, '-o', 'StrictHostKeyChecking=no', HOST, cmd],
        capture_output=True, text=True, timeout=timeout)
    return r

def upload(src, dst):
    with open(src, 'rb') as f:
        data = f.read()
    dst_py = ''.join(f'chr({ord(c)})+' for c in dst).rstrip('+')
    r = subprocess.run(
        ['ssh', '-i', KEY, '-o', 'StrictHostKeyChecking=no', HOST,
         f'docker exec -i vision-inference-gpu python3 -c '
         f'"import sys; open({dst_py},chr(119)+chr(98)).write(sys.stdin.buffer.read())"'],
        input=data, capture_output=True, timeout=30)
    status = 'OK' if r.returncode == 0 else 'FAIL'
    print(f'  [{status}] {os.path.basename(src):20s} {len(data)}b')

# git pull on Win
if MODE == 'pull':
    print('=== git pull on Win ===')
    ssh(f'cd C:\\Users\\spade\\vision-platform && git stash')
    ssh('del /f '
        'C:\\Users\\spade\\vision-platform\\vision-inference\\UI\\app.js '
        'C:\\Users\\spade\\vision-platform\\vision-inference\\UI\\style.css 2>nul & echo ok')
    r = ssh(f'cd C:\\Users\\spade\\vision-platform && git pull {REPO}')
    print(r.stdout.strip())
    if r.returncode != 0:
        print('ERROR:', r.stderr.strip())
        sys.exit(1)

# 上传文件到容器
print('=== uploading to Win container ===')
api_dir = f'{BASE}/api'
files = [
    (f'{BASE}/UI/index.html', '/app/UI/index.html'),
    (f'{BASE}/UI/style.css',  '/app/UI/style.css'),
    (f'{BASE}/UI/app.js',     '/app/UI/app.js'),
]
# Upload all api/*.py files
for fname in sorted(os.listdir(api_dir)):
    if fname.endswith('.py'):
        files.append((f'{api_dir}/{fname}', f'/app/api/{fname}'))
for src, dst in files:
    if os.path.exists(src):
        upload(src, dst)
    else:
        print(f'  SKIP: {src}')

# docker restart
if MODE in ('pull', 'restart'):
    print('=== docker restart ===')
    r = ssh('docker restart vision-inference-gpu', timeout=30)
    print('rc:', r.returncode)

print('=== done ===')
