#!/usr/bin/env python3
"""Real isolated nginx smoke; requires nginx + openssl, no production changes."""
import http.client, http.server, pathlib, socket, ssl, subprocess, tempfile, threading, time
REPO = pathlib.Path(__file__).resolve().parents[1]
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write((self.path+'|'+self.headers.get('X-Forwarded-Proto','')).encode()); self.wfile.flush()
        if self.path == '/stream': time.sleep(1.5); self.wfile.write(b'END')
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length',0)))
        self.send_response(200); self.end_headers(); self.wfile.write(str(len(body)).encode())
with tempfile.TemporaryDirectory(prefix='recruiter-nginx-') as d:
    d=pathlib.Path(d); hp,sp=port(),port()
    upstream=http.server.ThreadingHTTPServer(('127.0.0.1',0),Upstream)
    threading.Thread(target=upstream.serve_forever,daemon=True).start()
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(d/'key.pem'),'-out',str(d/'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    config=(REPO/'infra/nginx/recruiter-assistant.conf').read_text()
    config=config.replace('listen 80;',f'listen 127.0.0.1:{hp};').replace('listen 443 ssl;',f'listen 127.0.0.1:{sp} ssl;')
    config=config.replace('/etc/letsencrypt/live/recruiter-assistant.ru/fullchain.pem',str(d/'cert.pem')).replace('/etc/letsencrypt/live/recruiter-assistant.ru/privkey.pem',str(d/'key.pem'))
    config=config.replace('127.0.0.1:8080',f'127.0.0.1:{upstream.server_port}')
    config=config.replace('/var/www/html',str(d/'webroot'))
    challenge=d/'webroot/.well-known/acme-challenge';challenge.mkdir(parents=True);(challenge/'probe').write_text('acme-ok')
    (d/'nginx.conf').write_text(f'pid {d}/nginx.pid; error_log {d}/error.log; events {{}} http {{ access_log off; client_body_temp_path {d}/body; proxy_temp_path {d}/proxy; {config} }}')
    subprocess.run(['nginx','-t','-p',str(d),'-c',str(d/'nginx.conf')],check=True)
    p=subprocess.Popen(['nginx','-p',str(d),'-c',str(d/'nginx.conf'),'-g','daemon off;'])
    context=ssl.create_default_context(cafile=str(d/'cert.pem'))
    def request(path,host='recruiter-assistant.ru',secure=True,body=None):
        c=http.client.HTTPSConnection('127.0.0.1',sp,context=context,timeout=5) if secure else http.client.HTTPConnection('127.0.0.1',hp,timeout=5)
        c.request('GET' if body is None else 'POST',path,body=body,headers={'Host':host});r=c.getresponse();data=r.read();c.close();return r.status,dict(r.getheaders()),data
    try:
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1',sp),timeout=.1):break
            except OSError:time.sleep(.02)
        s,h,b=request('/');assert s==302 and h['Location'].endswith('/web/')
        for path in ['/hh-callback?code=a%2Bb&state=c%2Fd','/hh-callback?error=access_denied&state=x','/connect/hh/start?t=abc','/connect/hh/authorize?t=abc','/connect/hh?t=abc']:
            s,h,b=request(path);assert s==307 and h['Location']=='https://136-65-7-197.sslip.io'+path
            assert h['Cache-Control']=='no-store' and h['Referrer-Policy']=='no-referrer'
        for path in ['/web/login.html','/hh/candidate?neg_id=x','/vacancy/user/id']:
            s,h,b=request(path);assert s==200 and b.decode()==path+'|https'
        s,h,b=request('/hh-callback?state=a%2Bb',host='www.recruiter-assistant.ru');assert s==308 and h['Location']=='https://recruiter-assistant.ru/hh-callback?state=a%2Bb'
        s,h,b=request('/test?a=b',secure=False);assert s==308 and h['Location']=='https://recruiter-assistant.ru/test?a=b'
        s,h,b=request('/.well-known/acme-challenge/probe',secure=False);assert s==200 and b==b'acme-ok'
        s,h,b=request('/upload',body=b'x'*(2*1024*1024));assert s==200 and b==b'2097152'
        s,h,b=request('/upload',body=b'x'*(20*1024*1024));assert s==200 and b==b'20971520'
        c=http.client.HTTPSConnection('127.0.0.1',sp,context=context,timeout=5)
        c.request('POST','/upload',headers={'Host':'recruiter-assistant.ru','Content-Length':str(20*1024*1024+1)})
        assert c.getresponse().status==413;c.close()
        c=http.client.HTTPSConnection('127.0.0.1',sp,context=context,timeout=5);start=time.monotonic();c.request('GET','/stream',headers={'Host':'recruiter-assistant.ru'});r=c.getresponse()
        assert r.read(1)==b'/' and time.monotonic()-start<1,'SSE first bytes must arrive before upstream completes'
        assert r.read().endswith(b'END');c.close()
        print('PASS: TLS, root/login, OAuth query preservation, www, HTTP, ACME, candidate/vacancy routes, 2/20 MiB uploads, 413 boundary, streaming')
    finally:
        p.terminate();p.wait(timeout=5);upstream.shutdown()
