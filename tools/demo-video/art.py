# Original stylised illustrations for the demo video (no photos available offline)
import random, math, base64, os
from playwright.sync_api import sync_playwright
random.seed(7)
W, H = 900, 1200
def batllo():
    o = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (W, H, W, H)]
    o.append('<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7FAEDC"/><stop offset="1" stop-color="#DCEAF4"/></linearGradient>'
             '<linearGradient id="fac" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9E2D3"/><stop offset="1" stop-color="#D9CFBC"/></linearGradient>'
             '<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B3A4A"/><stop offset="1" stop-color="#4E6478"/></linearGradient>'
             '<clipPath id="fc"><path d="M190 300 C 260 250, 330 285, 400 255 C 470 225, 560 270, 640 238 C 680 222, 705 240, 715 260 L715 1010 L190 1010 Z"/></clipPath></defs>')
    o.append('<rect width="900" height="1200" fill="url(#sky)"/>')
    # neighbours
    o.append('<rect x="0" y="230" width="195" height="800" fill="#CBB89A"/><path d="M0 230 L40 230 L40 200 L80 200 L80 170 L120 170 L120 200 L160 200 L160 230 L195 230 L195 260 L0 260 Z" fill="#B9A27E"/>')
    for r in range(8):
        for c in range(3): o.append('<rect x="%d" y="%d" width="34" height="58" rx="3" fill="#5E5446"/>' % (22 + c * 58, 290 + r * 88))
    o.append('<rect x="715" y="330" width="185" height="700" fill="#C9B79D"/>')
    for r in range(7):
        for c in range(3): o.append('<rect x="%d" y="%d" width="32" height="56" rx="3" fill="#5A5144"/>' % (738 + c * 54, 370 + r * 90))
    # facade with broken-ceramic mosaic
    o.append('<g clip-path="url(#fc)"><rect x="190" y="220" width="525" height="800" fill="url(#fac)"/>')
    cols = ['#3A7BC8', '#3FB8AF', '#7CB342', '#E8A33D', '#E79CB5', '#6CA6E0', '#2E9C8F']
    for i in range(1700):
        x = random.uniform(190, 715); y = random.uniform(240, 760); r = random.uniform(2.5, 7)
        o.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" opacity="%.2f"/>' % (x, y, r, random.choice(cols), random.uniform(.55, .95)))
    # balconies: masks
    for row in range(4):
        for col in range(4):
            cx = 245 + col * 135 + (12 if row % 2 else 0); cy = 380 + row * 100
            o.append('<rect x="%d" y="%d" width="70" height="60" rx="8" fill="url(#glass)"/>' % (cx - 35, cy - 10))
            o.append('<path d="M%d %d q35 -26 70 0 l-6 34 q-29 18 -58 0 Z" fill="#F4F1EA" stroke="#B9B1A3" stroke-width="2"/>' % (cx - 35, cy + 30))
            o.append('<ellipse cx="%d" cy="%d" rx="9" ry="6" fill="#2B3A4A"/><ellipse cx="%d" cy="%d" rx="9" ry="6" fill="#2B3A4A"/>' % (cx - 15, cy + 36, cx + 15, cy + 36))
    # main floor: bones and glass
    o.append('<rect x="190" y="790" width="525" height="130" fill="#D8CDB6"/><rect x="205" y="805" width="495" height="100" rx="40" fill="url(#glass)"/>')
    for k in range(7):
        x = 230 + k * 75
        o.append('<path d="M%d 800 q-10 25 0 50 q10 25 0 60" stroke="#EFE8D8" stroke-width="16" fill="none" stroke-linecap="round"/>' % x)
        o.append('<circle cx="%d" cy="852" r="11" fill="#EFE8D8"/>' % x)
    o.append('<rect x="190" y="920" width="525" height="90" fill="#C9BDA3"/>')
    for k in range(4): o.append('<path d="M%d 1010 v-55 q32 -34 64 0 v55 Z" fill="#3A3F44"/>' % (225 + k * 125))
    o.append('</g>')
    # roof: dragon back with scales
    o.append('<path d="M330 290 C 380 210, 470 170, 560 200 C 620 220, 680 215, 715 260 L715 300 L330 300 Z" fill="#2E7D8C"/>')
    sc = ['#3FA7A0', '#5DBB8E', '#E6A6B8', '#F0C35A', '#4A90C2']
    for row in range(6):
        y = 214 + row * 15
        for k in range(26):
            x = 345 + k * 14 + (7 if row % 2 else 0)
            fy = 260 - 70 * math.exp(-((x - 540) / 140) ** 2) + row * 13
            if x > 712: continue
            o.append('<path d="M%.1f %.1f a8 8 0 0 0 16 0 Z" fill="%s"/>' % (x, fy, sc[(k + row) % len(sc)]))
    # turret with cross
    o.append('<rect x="292" y="190" width="40" height="110" rx="18" fill="#E9E2D3"/><circle cx="312" cy="180" r="26" fill="#C98A3A"/>'
             '<path d="M312 120 v44 M296 140 h32 M304 128 l16 24 M320 128 l-16 24" stroke="#E2B04A" stroke-width="7" stroke-linecap="round"/>')
    # street
    o.append('<rect x="0" y="1010" width="900" height="190" fill="#9A958C"/><rect x="0" y="1010" width="900" height="26" fill="#BDB6AA"/>')
    o.append('<path d="M60 1040 q10 -120 30 -240" stroke="#5B4A36" stroke-width="12" fill="none"/><circle cx="92" cy="770" r="70" fill="#5E8B4A" opacity=".9"/><circle cx="40" cy="820" r="55" fill="#4F7A3E" opacity=".9"/>')
    o.append('</svg>')
    return ''.join(o)
def tile(bg, fg, kind):
    o = ['<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="%s"/>' % bg]
    if kind == 'sagrada':
        o.append('<rect width="400" height="400" fill="#8FB8DE"/>')
        for i, h in enumerate([230, 290, 330, 290, 230]): o.append('<path d="M%d 400 L%d %d L%d 400 Z" fill="%s"/>' % (60 + i * 60, 90 + i * 60, 400 - h, 120 + i * 60, '#D2BE98'))
        for i in range(5): o.append('<circle cx="%d" cy="%d" r="7" fill="#E9A03B"/>' % (90 + i * 60, 400 - [230, 290, 330, 290, 230][i]))
    elif kind == 'pedrera':
        o.append('<rect width="400" height="400" fill="#9CC3E4"/>')
        for r in range(4): o.append('<path d="M0 %d q50 -30 100 0 t100 0 t100 0 t100 0 V%d H0 Z" fill="%s"/>' % (120 + r * 70, 400, ['#EFEAE0', '#E6DFD2', '#DDD5C6', '#D3CAB9'][r]))
        for r in range(3):
            for c in range(5): o.append('<path d="M%d %d q14 -10 28 0 v18 h-28 Z" fill="#3A4652"/>' % (25 + c * 75, 165 + r * 70))
    elif kind == 'lavender':
        o.append('<rect width="400" height="400" fill="#C7D9A8"/>')
        for i in range(14):
            x = 30 + i * 26
            o.append('<path d="M%d 400 q4 -110 %d -200" stroke="#6D8B4A" stroke-width="5" fill="none"/>' % (x, random.randint(-20, 20)))
            for k in range(7): o.append('<ellipse cx="%d" cy="%d" rx="8" ry="11" fill="%s"/>' % (x + random.randint(-14, 14), 205 + k * 14 + random.randint(-4, 4), random.choice(['#8A6BBE', '#9B7FD0', '#7558A8'])))
    else:  # generic facade
        for r in range(5):
            for c in range(4): o.append('<rect x="%d" y="%d" width="48" height="56" rx="6" fill="%s"/>' % (40 + c * 85, 60 + r * 68, fg))
    o.append('</svg>')
    return ''.join(o)
SV = {'batllo': (batllo(), W, H), 'sagrada': (tile('#8FB8DE', '', 'sagrada'), 400, 400), 'pedrera': (tile('#9CC3E4', '', 'pedrera'), 400, 400), 'lavender': (tile('', '', 'lavender'), 400, 400),
      'amatller': (tile('#D9B48A', '#6A4A2E', 'f'), 400, 400), 'lleo': (tile('#E7D3B8', '#7A5A40', 'f'), 400, 400), 'tapies': (tile('#B8462E', '#2E2A26', 'f'), 400, 400), 'palau': (tile('#C9573A', '#E8C27A', 'f'), 400, 400)}
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    for k, (svg, w, h) in SV.items():
        pg.set_viewport_size({'width': w, 'height': h}); pg.set_content('<html><body style="margin:0">' + svg + '</body></html>')
        pg.screenshot(path='img_%s.jpg' % k, type='jpeg', quality=86)
    b.close()
print({k: os.path.getsize('img_%s.jpg' % k) // 1024 for k in SV})
