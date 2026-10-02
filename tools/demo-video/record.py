# Films the real Strata app in demo mode (Hokusai), one take per language, with captions and tap marks.
import http.server, threading, functools, json, base64, os, sys, time, subprocess, shutil
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
APP = '/home/claude/strata'
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def translate_path(self, path):
        if path.startswith('/__fonts/'): return os.path.join(HERE, path.split('/')[-1])
        return os.path.join(APP, path.lstrip('/').split('?')[0] or 'index.html')
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8795), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
FONT_CSS = """
@font-face{font-family:'DM Serif Display';src:url(/__fonts/Lora-Variable.ttf);font-weight:100 900;font-style:normal}
@font-face{font-family:'DM Serif Display';src:url(/__fonts/Lora-Italic-Variable.ttf);font-weight:100 900;font-style:italic}
@font-face{font-family:'DM Sans';src:url(/__fonts/Poppins-Light.ttf);font-weight:300}
@font-face{font-family:'DM Sans';src:url(/__fonts/Poppins-Regular.ttf);font-weight:400}
@font-face{font-family:'DM Sans';src:url(/__fonts/Poppins-Medium.ttf);font-weight:500 700}
"""
L = json.load(open(os.path.join(HERE, 'langs.json')))
OVERLAY_CSS = """
#camStatus,.mode-pill,.legend{display:none!important}
#vcap{position:absolute;left:50%;top:118px;transform:translate(-50%,-8px);z-index:9000;opacity:0;transition:opacity .35s,transform .35s;
 background:rgba(16,42,92,.92);color:#fff;font:500 15px 'DM Sans',sans-serif;padding:10px 16px 10px 12px;border-radius:100px;white-space:nowrap;display:flex;gap:9px;align-items:center;box-shadow:0 6px 22px rgba(0,0,0,.28)}
#vcap.on{opacity:1;transform:translate(-50%,0)}
#vcap.low{top:auto;bottom:118px}
#vcap i{font-style:normal;width:22px;height:22px;border-radius:7px;background:#F4C542;color:#16346B;font:700 12px 'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center}
.vtap{position:absolute;z-index:9001;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(244,197,66,.55);border:2px solid #fff;pointer-events:none;animation:vtap .65s ease-out forwards}
@keyframes vtap{0%{transform:scale(.4);opacity:0}25%{opacity:1}100%{transform:scale(1.25);opacity:0}}
#vend{position:absolute;inset:0;z-index:9500;background:radial-gradient(ellipse 80% 55% at 50% 40%,#1E4F99,#102A5C 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;opacity:0;transition:opacity .6s}
#vend.on{opacity:1}
#vend .lg{width:112px;height:112px;border-radius:28px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.4)}
#vend .nm{font:400 46px 'DM Serif Display',serif;color:#fff}
#vend .tg{font:italic 400 19px 'DM Serif Display',serif;color:#F8E08E}
#vend .sb{font:400 14px 'DM Sans',sans-serif;color:rgba(255,255,255,.75);margin-top:10px;text-align:center;max-width:280px;line-height:1.5}
"""
def run(lang):
    T = L[lang]; frames = []; outdir = os.path.join(HERE, 'frames_' + lang)
    shutil.rmtree(outdir, ignore_errors=True); os.makedirs(outdir)
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True)
        ctx.add_init_script("localStorage.setItem('strata.welcomed','1');localStorage.setItem('strata.lang','" + lang + "');localStorage.setItem('strata.cam','viewfinder');localStorage.removeItem('strata.apiKey');")
        pg = ctx.new_page()
        pg.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=FONT_CSS))
        for pat in ['https://cdnjs.cloudflare.com/**', 'https://*.wikipedia.org/**', 'https://*.supabase.co/**', 'https://commons.wikimedia.org/**', 'https://openlibrary.org/**']:
            pg.route(pat, lambda r: r.fulfill(status=404, body=''))
        pg.goto('http://127.0.0.1:8795/'); pg.wait_for_timeout(1200)
        pg.evaluate("document.fonts.ready")
        # demo content in this language, overlays
        pg.evaluate("""([css, d]) => {
          const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
          const a = ARTS.hokusai; Object.assign(a, { title: d.title, spark: d.spark, story: d.story, surp: d.surp });
          a.meta = ['Katsushika Hokusai', 'c. 1830–32', d.medium];
          a.more.forEach((m, i) => { m[0] = d.more[i][0]; m[2] = d.more[i][1]; });
          a.chat.sub = d.chat_sub; a.chat.intro = d.chat_intro; a.chat.chips = d.chips; a.chat.answers = {}; a.chat.answers[d.chips[0]] = d.answer;
          const ph = document.querySelector('.phone');
          const c = document.createElement('div'); c.id = 'vcap'; ph.appendChild(c);
          const e = document.createElement('div'); e.id = 'vend'; e.innerHTML = '<div class="lg" data-logo></div><div class="nm">Strata</div><div class="tg"></div><div class="sb"></div>'; ph.appendChild(e);
          e.querySelector('.tg').textContent = d.end_tag; e.querySelector('.sb').textContent = d.end_sub; paintLogos();
          window.vcap = (n, txt, low) => { c.classList.remove('on'); setTimeout(() => { c.classList.toggle('low', !!low); c.innerHTML = (n ? '<i>' + n + '</i>' : '') + txt; c.classList.add('on'); }, n === 1 ? 0 : 180); };
          window.vtap = (sel) => { const el = document.querySelector(sel); if (!el) return; const r = el.getBoundingClientRect(), pr = ph.getBoundingClientRect();
            const t = document.createElement('div'); t.className = 'vtap'; t.style.left = (r.left - pr.left + r.width / 2) + 'px'; t.style.top = (r.top - pr.top + r.height / 2) + 'px'; ph.appendChild(t); setTimeout(() => t.remove(), 700); };
        }""", [OVERLAY_CSS, T])
        pg.evaluate("currentArt = 'hokusai'; renderedChat = null; show('s-camera')"); pg.wait_for_timeout(400)
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        # start filming
        cdp = ctx.new_cdp_session(pg)
        def on_frame(ev):
            frames.append((ev['metadata']['timestamp'], ev['data'])); cdp.send('Page.screencastFrameAck', {'sessionId': ev['sessionId']})
        cdp.on('Page.screencastFrame', on_frame)
        cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 88, 'maxWidth': 780, 'maxHeight': 1688, 'everyNthFrame': 1})
        W = pg.wait_for_timeout; E = pg.evaluate
        W(300); E("vcap(1, %s)" % json.dumps(T['cap'][0])); W(1500)
        E("vtap('#btn-shutter')"); W(220)
        E("(()=>{const v=document.getElementById('camVf'); v.classList.remove('cam-flash'); void v.offsetWidth; v.classList.add('cam-flash');})()"); W(250)
        E("show('s-scanning'); document.getElementById('scanSub').textContent = %s; vcap(2, %s)" % (json.dumps(T['powered']), json.dumps(T['cap'][1]))); W(2350)
        E("vcap(3, %s)" % json.dumps(T['cap'][2])); W(2300)
        for k in (1, 2):
            E("vtap('.dot[data-i=\"%d\"]'); currentCard = %d; updateCarousel(true)" % (k, k)); W(2300)
        E("vtap('#btn-chat-ico')"); W(200); E("show('s-chat'); vcap(4, %s, true)" % json.dumps(T['cap'][3])); W(1300)
        E("(()=>{ const c=[...document.querySelectorAll('#chatMsgs .chip')][0]; if (c) { vtap('#chatMsgs .chip'); setTimeout(()=>c.click(), 150); } })()"); W(4600)
        E("show('s-result'); currentCard = 0; updateCarousel(false)"); W(450)
        E("vtap('#btn-share')"); W(150); E("openShare(); vcap(5, %s)" % json.dumps(T['cap'][4])); W(3200)
        E("""(async()=>{ document.getElementById('shareSheet').hidden = true;
             const blob = await (await fetch(IMG_ART)).blob();
             const d = { title: ARTS.hokusai.title, creator: 'Katsushika Hokusai', artist_short: 'Hokusai', category: 'print', identified: true, lang: '%s',
               spark: { head: ARTS.hokusai.spark[0], body: ARTS.hokusai.spark[1] }, story: {}, surprise: {}, location: { place: 'The Met', city: 'New York', country: 'USA', lat: 40.78, lng: -73.96 } };
             const th = await resizeBlob(blob, 360, .8, true);
             await tx('readwrite', s => s.put({ id: 'demo1', created_at: new Date().toISOString(), title: d.title, creator: d.creator, artist_short: 'Hokusai', category: 'painting', identified: true, data: d, photo: blob, thumb: th }));
             await loadJournal(); show('s-home'); })()""" % lang); W(300)
        E("vcap(6, %s, true)" % json.dumps(T['cap'][5])); W(2300)
        E("document.getElementById('vcap').classList.remove('on'); document.getElementById('vend').classList.add('on')"); W(3000)
        cdp.send('Page.stopScreencast'); W(200)
        if errs: print('page errors:', errs)
        b.close()
    # frames → constant 30 fps video
    t0 = frames[0][0]; listing = []
    for i, (ts, data) in enumerate(frames):
        fn = os.path.join(outdir, '%05d.jpg' % i); open(fn, 'wb').write(base64.b64decode(data))
        nxt = frames[i + 1][0] if i + 1 < len(frames) else ts + 0.5
        listing.append("file '%s'\nduration %.4f" % (fn, max(0.001, nxt - ts)))
    listing.append("file '%s'" % fn)
    lst = os.path.join(outdir, 'list.txt'); open(lst, 'w').write('\n'.join(listing))
    out = os.path.join(HERE, 'strata-demo-%s.mp4' % lang)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', 'fps=30,scale=600:-2:flags=lanczos,format=yuv420p',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-movflags', '+faststart', '-an', out], check=True)
    poster = os.path.join(HERE, 'strata-demo-poster.jpg')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '4.9', '-i', out, '-frames:v', '1', '-q:v', '4', poster], check=True)
    print(lang, len(frames), 'frames', round(frames[-1][0] - t0, 1), 's', os.path.getsize(out) // 1024, 'KB')
for lang in (sys.argv[1:] or ['en']): run(lang)
srv.shutdown()
