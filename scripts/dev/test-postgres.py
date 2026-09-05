"""Run API integration tests against an isolated native PostgreSQL cluster."""
import os
import json
import socket as sockets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
from urllib.error import HTTPError
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlencode

root = Path(__file__).resolve().parents[2]
bin_dir = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
bun = shutil.which('bun')
if not bun:
    raise SystemExit('Put Bun on PATH before running this check.')
with tempfile.TemporaryDirectory(prefix='mandate-api-pg-') as temp:
    data = Path(temp) / 'data'
    socket = Path(temp) / 'socket'
    socket.mkdir()
    log = Path(temp) / 'postgres.log'
    def run(args, **kwargs):
        return subprocess.run(args, cwd=root, check=True, **kwargs)
    run([str(bin_dir / 'initdb'), '-D', str(data), '-A', 'trust', '-U', 'test_owner', '--no-locale'], stdout=subprocess.DEVNULL)
    started = False
    try:
        run([str(bin_dir / 'pg_ctl'), '-D', str(data), '-l', str(log), '-o', f"-h '' -k {socket} -p 57931", '-w', 'start'], stdout=subprocess.DEVNULL)
        started = True
        psql = [str(bin_dir / 'psql'), '-h', str(socket), '-p', '57931', '-U', 'test_owner', '-v', 'ON_ERROR_STOP=1']
        run(psql + ['-d', 'postgres', '-c', 'create database mandate_test'], stdout=subprocess.DEVNULL)
        query = urlencode({'host': str(socket), 'port': '57931'})
        owner_url = f'postgresql://test_owner@localhost/mandate_test?{query}'
        env = {**os.environ, 'MIGRATION_DATABASE_URL': owner_url}
        run(['node', '--import', 'tsx', 'scripts/database/migrate.ts'], env=env)
        run(psql + ['-d', 'mandate_test', '-c', 'create role api_test login nosuperuser nobypassrls; grant usage on schema mandate_v2 to api_test; grant select, insert, update, delete on all tables in schema mandate_v2 to api_test;'], stdout=subprocess.DEVNULL)
        env['TEST_DATABASE_URL'] = f'postgresql://api_test@localhost/mandate_test?{query}'
        run([bun, 'test', 'apps/api/test/trading.test.ts', 'apps/worker/test/worker.test.ts'], env=env)
        run([bun, 'run', 'build:worker'], env=env)
        run([bun, 'run', 'build:api'], env=env)
        class Rpc(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                def answer(item):
                    return {'jsonrpc': '2.0', 'id': item['id'], 'result': '0x2105' if item['method'] == 'eth_chainId' else '0x1'}
                body = json.dumps([answer(item) for item in payload] if isinstance(payload, list) else answer(payload)).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_args):
                pass
        rpc = ThreadingHTTPServer(('127.0.0.1', 0), Rpc)
        threading.Thread(target=rpc.serve_forever, daemon=True).start()
        with sockets.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            api_port = probe.getsockname()[1]
        server_env = {**env, 'DATABASE_URL': env['TEST_DATABASE_URL'], 'NODE_ENV': 'test', 'HOST': '127.0.0.1', 'PORT': str(api_port), 'PRIVY_APP_ID': 'smoke-test', 'PRIVY_APP_SECRET': 'local-fixture', 'BASE_RPC_URL': f'http://127.0.0.1:{rpc.server_port}', 'LOG_LEVEL': 'silent'}
        server = subprocess.Popen(['node', 'apps/api/dist/main.js'], cwd=root, env=server_env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            origin = f'http://127.0.0.1:{api_port}'
            for attempt in range(50):
                try:
                    with urlopen(origin + '/health', timeout=1) as response:
                        assert response.status == 200
                    break
                except OSError:
                    if server.poll() is not None:
                        raise RuntimeError('Built Node API exited before becoming healthy')
                    time.sleep(0.1)
            else:
                raise RuntimeError('Built Node API did not become healthy')
            with urlopen(origin + '/ready', timeout=5) as response:
                assert response.status == 200
                assert json.load(response)['execution_available'] is False
            try:
                urlopen(origin + '/v1/me', timeout=5)
                raise AssertionError('Unauthenticated identity request was accepted')
            except HTTPError as error:
                assert error.code == 401
            server.terminate()
            assert server.wait(timeout=15) == 0
            print('Built Node API passed HTTP liveness, PostgreSQL readiness, auth rejection and graceful shutdown checks.')
        finally:
            if server.poll() is None:
                server.kill()
                server.wait()
        worker = subprocess.Popen(['node', 'apps/worker/dist/main.js'], cwd=root, env={**server_env, 'WORKER_EXECUTE': '0', 'WORKER_POLL_MS': '250'}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for attempt in range(100):
                probe = run(psql + ['-d', 'mandate_test', '-Atc', "select count(*) from mandate_v2.worker_state where heartbeat_at > now() - interval '5 seconds'"], capture_output=True, text=True)
                if probe.stdout.strip() == '1':
                    break
                if worker.poll() is not None:
                    raise RuntimeError('Built Node worker exited before heartbeat')
                time.sleep(0.1)
            else:
                raise RuntimeError('Built Node worker did not publish a heartbeat')
            worker.terminate()
            assert worker.wait(timeout=30) == 0
            print('Built Node worker passed PostgreSQL startup, leader heartbeat and graceful shutdown checks.')
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.wait()
        rpc.shutdown()
        rpc.server_close()
        print('Native PostgreSQL API and worker integration passed with a non-superuser role.')
    finally:
        if started:
            subprocess.run([str(bin_dir / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'], check=False, stdout=subprocess.DEVNULL)
