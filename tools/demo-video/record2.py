# Films the real Strata app (demo data: Casa Batlló, Barcelona), one take per language, with captions and tap marks.
import http.server, threading, functools, json, base64, os, sys, subprocess, shutil, datetime
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, '..', 'video')
APP = '/home/claude/strata'
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def translate_path(self, path):
        if path.startswith('/__fonts/'): return os.path.join(FONTS, path.split('/')[-1])
        return os.path.join(APP, path.lstrip('/').split('?')[0] or 'index.html')
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8796), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
FONT_CSS = """
@font-face{font-family:'DM Serif Display';src:url(/__fonts/Lora-Variable.ttf);font-weight:100 900;font-style:normal}
@font-face{font-family:'DM Serif Display';src:url(/__fonts/Lora-Italic-Variable.ttf);font-weight:100 900;font-style:italic}
@font-face{font-family:'DM Sans';src:url(/__fonts/Poppins-Light.ttf);font-weight:300}
@font-face{font-family:'DM Sans';src:url(/__fonts/Poppins-Regular.ttf);font-weight:400}
@font-face{font-family:'DM Sans';src:url(/__fonts/Poppins-Medium.ttf);font-weight:500 700}
"""
L = json.load(open(os.path.join(HERE, 'langs2.json')))
def durl(name): return 'data:image/jpeg;base64,' + base64.b64encode(open(os.path.join(HERE, 'img_%s.jpg' % name), 'rb').read()).decode()
IMG = {k: durl(k) for k in ['batllo', 'sagrada', 'pedrera', 'lavender', 'amatller', 'lleo', 'tapies', 'palau']}
TILE = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(HERE, 'tile.png'), 'rb').read()).decode()
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
#vmap{position:absolute;inset:0;background-size:84px 84px;filter:saturate(.8)}
"""
POS = {'lat': 41.3917, 'lng': 2.1652}
PLACES = [('batllo', 'arch', 41.3916, 2.1649, 'Casa Batlló', 120), ('amatller', 'arch', 41.3918, 2.1646, None, 40), ('lleo', 'arch', 41.3912, 2.1655, None, 30),
          ('tapies', 'museum', 41.3915, 2.1630, None, 35), ('pedrera', 'arch', 41.3953, 2.1619, None, 90), ('palau', 'arch', 41.3875, 2.1753, None, 80), ('sagrada', 'arch', 41.4036, 2.1744, None, 150)]
def run(lang):
    T = L[lang]; frames = []; outdir = os.path.join(HERE, 'frames_' + lang)
    shutil.rmtree(outdir, ignore_errors=True); os.makedirs(outdir)
    today = datetime.date.today(); days = [(today - datetime.timedelta(days=k)).isoformat() for k in (4, 3, 2, 1)]
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True)
        ctx.add_init_script("localStorage.clear();localStorage.setItem('strata.welcomed','1');localStorage.setItem('strata.lang','" + lang + "');localStorage.setItem('strata.cam','viewfinder');localStorage.setItem('strata.nearIntro','1');"
                            "localStorage.setItem('strata.profile', JSON.stringify({name:'Elie', quiz:{streak:4, best:4, last:'" + days[-1] + "', days:" + json.dumps(days) + "}}));")
        pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=FONT_CSS))
        for pat in ['https://cdnjs.cloudflare.com/**', 'https://*.wikipedia.org/**', 'https://*.supabase.co/**', 'https://commons.wikimedia.org/**', 'https://*.wikidata.org/**', 'https://openlibrary.org/**', 'https://api.anthropic.com/**']:
            pg.route(pat, lambda r: r.fulfill(status=404, body=''))
        pg.goto('http://127.0.0.1:8796/'); pg.wait_for_timeout(1200)
        pg.evaluate("document.fonts.ready")
        pg.evaluate("""async ([css, d, IMG, PLACES, POS, lang]) => {
          const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
          const blob = async (u) => (await fetch(u)).blob();
          const Q = (q, lv) => ({ level: lv, q: q.q, options: q.options, answer: 0, explain: q.explain, visual: false });
          const loc = { place: 'Casa Batlló', city: 'Barcelona', country: 'Spain', lat: 41.3916, lng: 2.1649 };
          const dB = { identified: true, confidence: 'high', category: 'architecture', title: 'Casa Batlló', title_en: 'Casa Batlló', creator: 'Antoni Gaudí', artist_short: 'Gaudí', date: '1904–1906', medium: d.medium, lang,
            location: loc, entry: 'ticketed', place_wiki: 'Casa Batlló', loc_v: 2, spark: { head: d.spark[0], body: d.spark[1] }, story: { head: d.story[0], body: d.story[1].replace(/<br><br>/g, '\\n\\n') }, surprise: { head: d.surp[0], body: d.surp[1] },
            more_by: d.more.map(m => ({ title: m[0], year: m[1], hook: m[2] })), quiz: [Q(d.quiz, 'easy'), Q(d.q2, 'medium'), Q(d.q3, 'hard')], qz: { box: 0, due: '2020-01-01', n: 0 } };
          const dS = { identified: true, category: 'architecture', title: 'Sagrada Família', creator: 'Antoni Gaudí', artist_short: 'Gaudí', lang, loc_v: 2, location: { place: 'Sagrada Família', city: 'Barcelona', lat: 41.4036, lng: 2.1744 }, spark: {}, story: {}, surprise: {}, rating: 4,
            quiz: [Q(d.q2, 'easy'), Q(d.q2, 'medium'), Q(d.q2, 'hard')], qz: { box: 1, due: '2020-01-01', n: 0 } };
          const dP = { identified: true, category: 'architecture', title: 'La Pedrera', creator: 'Antoni Gaudí', artist_short: 'Gaudí', lang, loc_v: 2, location: { place: 'La Pedrera', city: 'Barcelona', lat: 41.3953, lng: 2.1619 }, spark: {}, story: {}, surprise: {},
            quiz: [Q(d.q3, 'easy'), Q(d.q3, 'medium'), Q(d.q3, 'hard')], qz: { box: 2, due: '2020-01-01', n: 0 } };
          const dL = { identified: true, category: 'plant', title: d.lavender, creator: 'Lavandula', artist_short: 'Lavandula', lang, loc_v: 2, location: { place: '', city: '', lat: 41.4145, lng: 2.1527, seen: true, seen_at: new Date().toISOString() }, spark: {}, story: {}, surprise: {} };
          const recs = [['demo4', dL, IMG.lavender, 'plants', 9], ['demo3', dP, IMG.pedrera, 'arch', 6], ['demo2', dS, IMG.sagrada, 'arch', 3], ['demo1', dB, IMG.batllo, 'arch', 0]];
          for (const [id, data, img, cat, ago] of recs) {
            const ph = await blob(img), th = await resizeBlob(ph, 360, .8, true);
            await tx('readwrite', s => s.put({ id, created_at: new Date(Date.now() - ago * 864e5 - 3600e3).toISOString(), title: data.title, creator: data.creator, artist_short: data.artist_short, category: cat, identified: true, data, photo: ph, thumb: th }));
          }
          await loadJournal();
          // the demo artwork shown on the result screen
          const a = JSON.parse(JSON.stringify(ARTS.hokusai));
          Object.assign(a, { title: 'Casa Batlló', meta: ['Antoni Gaudí', '1904–1906', d.medium], img: IMG.batllo, badge: 'url(' + IMG.batllo + ')', photo: true, live: false, identified: true,
            spark: d.spark, story: d.story, surp: d.surp, artist: 'Gaudí', category: 'architecture', nature: false, journalId: 'demo1', raw: dB,
            links: [['museum', 'Casa Batlló', 'casabatllo.es'], ['read', 'Works of Antoni Gaudí', 'whc.unesco.org'], ['read', 'Barcelona modernisme', 'barcelona.cat']] });
          const tiles = [IMG.sagrada, IMG.pedrera, IMG.lavender, IMG.palau];
          a.more = d.more.map((m, i) => [m[0], m[1], m[2], 'background:url(' + [IMG.sagrada, IMG.pedrera, IMG.amatller, IMG.palau][i] + ') center/cover;', '', '']);
          a.chat.sub = d.chat_sub; a.chat.intro = d.chat_intro; a.chat.chips = d.chips; a.chat.answers = {}; a.chat.answers[d.chips[0]] = d.answer;
          ARTS.batllo = a;
          document.getElementById('camVf').style.backgroundImage = 'linear-gradient(to bottom,rgba(0,0,0,.35) 0%,transparent 30%,transparent 65%,rgba(0,0,0,.55) 100%),url(' + IMG.batllo + ')';
          document.getElementById('camVf').style.backgroundSize = 'cover'; document.getElementById('camVf').style.backgroundPosition = 'center';
          // places around
          window._near = PLACES.map(([k, kind, lat, lng, title, fame]) => {
            const n = d.near[k] || [title, '', ''];
            return { id: k, qid: k, title: n[0], desc: n[1] || '', extract: n[2] || '', article: '', thumb: IMG[k], lat, lng, dist: distM(POS, { lat, lng }), kind, fame, lang, score: 0 };
          });
          const ph = document.querySelector('.phone');
          const c = document.createElement('div'); c.id = 'vcap'; ph.appendChild(c);
          const e = document.createElement('div'); e.id = 'vend'; e.innerHTML = '<div class="lg" data-logo></div><div class="nm">Strata</div><div class="tg"></div><div class="sb"></div>'; ph.appendChild(e);
          e.querySelector('.tg').textContent = d.end_tag; e.querySelector('.sb').textContent = d.end_sub; paintLogos();
          window.vcap = (n, txt, low) => { c.classList.remove('on'); setTimeout(() => { c.classList.toggle('low', !!low); c.innerHTML = (n ? '<i>' + n + '</i>' : '') + txt; c.classList.add('on'); }, n === 1 ? 0 : 180); };
          window.vtap = (sel) => { const el = document.querySelector(sel); if (!el) return; const r = el.getBoundingClientRect(), pr = ph.getBoundingClientRect();
            const t = document.createElement('div'); t.className = 'vtap'; t.style.left = (r.left - pr.left + r.width / 2) + 'px'; t.style.top = (r.top - pr.top + r.height / 2) + 'px'; ph.appendChild(t); setTimeout(() => t.remove(), 700); };
          // map stand-in for the recording (same pins as the app)
          window.vmap = () => {
            const m = document.getElementById('nmap'); m.innerHTML = '';
            const box = m.getBoundingClientRect(), pts = NR.places.filter(p => p.dist < 700).concat([{ lat: POS.lat, lng: POS.lng }]);
            const la = pts.map(p => p.lat), ln = pts.map(p => p.lng), pad = 26;
            const minLa = Math.min(...la), maxLa = Math.max(...la), minLn = Math.min(...ln), maxLn = Math.max(...ln);
            const sx = (box.width - 2 * pad) / (maxLn - minLn), sy = (box.height - 2 * pad) / (maxLa - minLa), s = Math.min(sx, sy);
            const ox = (box.width - s * (maxLn - minLn)) / 2, oy = (box.height - s * (maxLa - minLa)) / 2;
            const xy = (p) => [ox + (p.lng - minLn) * s, oy + (maxLa - p.lat) * s];
            const bg = document.createElement('div'); bg.id = 'vmap'; bg.style.backgroundImage = 'url(' + window._tile + ')'; m.appendChild(bg);
            NR.places.forEach((p, i) => { const [x, y] = xy(p), mine = nrInJournal(p), el = document.createElement('div');
              el.className = 'nr-pin' + (mine ? ' mine' : ''); el.innerHTML = mine ? CHECK : String(i + 1); el.style.cssText = 'position:absolute;left:' + (x - 15) + 'px;top:' + (y - 15) + 'px'; m.appendChild(el); });
            const [mx, my] = xy(POS), me = document.createElement('div'); me.className = 'nr-me'; me.style.cssText = 'position:absolute;left:' + (mx - 11) + 'px;top:' + (my - 11) + 'px'; m.appendChild(me);
          };
        }""", [OVERLAY_CSS, T, IMG, PLACES, POS, lang])
        pg.evaluate("t => { window._tile = t; }", TILE)
        pg.evaluate("currentArt = 'batllo'; renderedChat = null; show('s-camera')"); pg.wait_for_timeout(500)
        cdp = ctx.new_cdp_session(pg)
        def on_frame(ev):
            frames.append((ev['metadata']['timestamp'], ev['data'])); cdp.send('Page.screencastFrameAck', {'sessionId': ev['sessionId']})
        cdp.on('Page.screencastFrame', on_frame)
        cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 88, 'maxWidth': 780, 'maxHeight': 1688, 'everyNthFrame': 1})
        W = pg.wait_for_timeout; E = pg.evaluate; C = lambda i: json.dumps(T['cap'][i])
        # 1 point
        W(300); E("vcap(1, %s)" % C(0)); W(1500)
        E("vtap('#btn-shutter')"); W(220)
        E("(()=>{const v=document.getElementById('camVf'); v.classList.remove('cam-flash'); void v.offsetWidth; v.classList.add('cam-flash');})()"); W(250)
        # 2 recognise (demo mode: checklist, then the result)
        E("show('s-scanning'); document.getElementById('scanSub').textContent = 'Powered by Claude'; vcap(2, %s)" % C(1)); W(2500)
        # 3 layers
        E("vcap(3, %s)" % C(2)); W(2300)
        E("vtap('#s-result .dot[data-i=\"1\"]'); currentCard = 1; updateCarousel(true)"); W(2400)
        # 4 where to see it
        E("vtap('#s-result .dot[data-i=\"4\"]'); currentCard = 4; updateCarousel(true); vcap(4, %s)" % C(3)); W(2700)
        # 5 chat
        E("vtap('#btn-chat-ico')"); W(200); E("show('s-chat'); vcap(5, %s, true)" % C(4)); W(1200)
        E("(()=>{ const c=[...document.querySelectorAll('#chatMsgs .chip')][0]; if (c) { vtap('#chatMsgs .chip'); setTimeout(()=>c.click(), 150); } })()"); W(4200)
        # 6 rate
        E("show('s-result'); currentCard = 0; updateCarousel(false); vcap(6, %s)" % C(5)); W(1000)
        E("vtap('#resStars .rs-star[data-n=\"5\"]'); setTimeout(()=>document.querySelector('#resStars .rs-star[data-n=\"5\"]').click(), 160)"); W(1800)
        # 7 quiz
        E("show('s-home'); document.querySelector('#s-home .home-body').scrollTop = 0; vcap(7, %s, true)" % C(6)); W(1500)
        W(500); E("vtap('#quizCard [data-qz=start]'); setTimeout(()=>document.querySelector('#quizCard [data-qz=start]').click(), 160)"); W(1700)
        E("(()=>{ const k = qz.session.items[0].q.answer; vtap('.qz-opt[data-o=\"' + k + '\"]'); setTimeout(()=>answerQuiz(k), 160); })()"); W(2600)
        # 8 around me
        E("qz.session = null; markQuizDay(); NR.pos = %s; NR.city = ''; NR.radius = 3000; NR.places = window._near; NR.works = []; NR.cat = 'all'; show('s-near'); renderNear(); vmap(); vcap(8, %s, true)" % (json.dumps(POS), C(7))); W(2000)
        E("vtap('.nr-row[data-i=\"1\"]'); setTimeout(()=>nrOpen(1), 160)"); W(2600)
        # 9 journal
        E("document.getElementById('nrSheet').hidden = true; show('s-home'); renderJournal(); const hb = document.querySelector('#s-home .home-body'); hb.scrollTop = 0; vcap(9, %s, true)" % C(8)); W(1200)
        E("(()=>{ const hb = document.querySelector('#s-home .home-body'), f = document.getElementById('favSec'); hb.scrollTo({ top: f ? f.offsetTop - 12 : 300, behavior: 'smooth' }); })()"); W(2000)
        E("document.getElementById('vcap').classList.remove('on'); document.getElementById('vend').classList.add('on')"); W(3000)
        cdp.send('Page.stopScreencast'); W(200)
        if errs: print('page errors:', errs)
        b.close()
    t0 = frames[0][0]; listing = []
    for i, (ts, data) in enumerate(frames):
        fn = os.path.join(outdir, '%05d.jpg' % i); open(fn, 'wb').write(base64.b64decode(data))
        nxt = frames[i + 1][0] if i + 1 < len(frames) else ts + 0.5
        listing.append("file '%s'\nduration %.4f" % (fn, max(0.001, nxt - ts)))
    listing.append("file '%s'" % fn)
    lst = os.path.join(outdir, 'list.txt'); open(lst, 'w').write('\n'.join(listing))
    out = os.path.join(HERE, 'strata-demo2-%s.mp4' % lang)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', 'fps=30,scale=600:-2:flags=lanczos,format=yuv420p',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-movflags', '+faststart', '-an', out], check=True)
    poster = os.path.join(HERE, 'poster2-%s.jpg' % lang)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '6.2', '-i', out, '-frames:v', '1', '-q:v', '4', poster], check=True)
    print(lang, len(frames), 'frames', round(frames[-1][0] - t0, 1), 's', os.path.getsize(out) // 1024, 'KB')
for lang in (sys.argv[1:] or ['fr']): run(lang)
srv.shutdown()
