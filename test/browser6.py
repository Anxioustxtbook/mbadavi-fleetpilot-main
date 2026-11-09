import subprocess, time, os, datetime
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-main.js"></script>')
open(ROOT+'/test/harness.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8781','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; bad=[]; ok=lambda n,c: (print(('PASS ' if c else 'FAIL ')+n), None if c else bad.append(n))
D='2026-10-20'
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':1200})
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog',lambda d: d.accept('1234'))
    pg.add_init_script("""new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8781/test/harness.html'); pg.wait_for_timeout(1500)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'P.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2000)
    pg.click('.nav button[data-panel="payments"]'); pg.wait_for_timeout(500)
    ok('payments hub draws form and list', pg.locator('#ph_form').count()==1 and pg.locator('#ph_list tbody tr').count()>50)
    ok('old table and old form are hidden', not pg.locator('#oldPayList').is_visible() and not pg.locator('#oldPayForm').is_visible())
    def fill(sel,val): pg.fill(sel,val)
    def rec(): pg.click('#ph_go'); pg.wait_for_timeout(500)
    def pick(cat): pg.select_option('#ph_cat',cat); pg.wait_for_timeout(200)
    def popup(): return pg.locator('#phAsk').count()==1
    # ---- Money out: airport 300 on a car
    pg.click('[data-dir="out"]'); pick('x:Airport')
    veh=pg.evaluate("[...document.querySelectorAll('#ph_vehicleId option')].filter(o=>o.value)[0].value"); pg.select_option('#ph_vehicleId',veh)
    fill('[data-f="date"]',D); fill('[data-f="amount"]','300'); rec()
    ok('airport 300: no pop-up needed, confirmation shown', not popup() and 'Airport' in pg.inner_text('#ph_done'))
    pg.select_option('#ph_fmonth','2026-10'); pg.select_option('#ph_fcat','Airport'); pg.wait_for_timeout(300)
    t=pg.inner_text('#ph_list'); ok('it is in the list with its date, as OUT', D in t and 'OUT' in t and '300' in t)
    # same again -> duplicate pop-up
    fill('[data-f="date"]',D); fill('[data-f="amount"]','300'); pg.select_option('#ph_vehicleId',veh); rec()
    ok('same payment again: pop-up asks (duplicate)', popup() and 'already recorded' in pg.inner_text('#phAsk') or 'one already' in pg.inner_text('#phAsk'))
    pg.click('#phAsk [data-cancel]'); pg.wait_for_timeout(200)
    # ---- rent
    pick('rent'); fill('[data-f="amount"]','7000'); fill('[data-f="date"]',D); rec()
    if popup(): print('rent popup:', pg.inner_text('#phAsk h2')); pg.click('#phAsk [data-i="0"]'); pg.wait_for_timeout(400)
    ok('rent recorded', 'Rent' in pg.inner_text('#ph_done'))
    # ---- fuel: asks which
    pick('fuel'); fill('[data-f="amount"]','5000'); fill('[data-f="date"]',D); rec()
    ok('fuel asks top-up or fill', popup() and 'Fuel' in pg.inner_text('#phAsk h2'))
    pg.click('#phAsk [data-i="0"]'); pg.wait_for_timeout(500); ok('fuel top-up recorded', 'station' in pg.inner_text('#ph_done'))
    # ---- no amount -> toast
    pick('x:Garage'); fill('[data-f="amount"]',''); rec(); ok('missing amount is refused with a message', 'amount' in pg.inner_text('#toast').lower())
    # ---- sub-hire driver
    pick('driver'); n=pg.evaluate("[...document.querySelectorAll('#ph_driver option')].filter(o=>o.value).length"); print('drivers with jobs not cleared:', n)
    if n:
        dv=pg.evaluate("[...document.querySelectorAll('#ph_driver option')].filter(o=>o.value)[0].value"); pg.select_option('#ph_driver',dv); pg.wait_for_timeout(300)
        pg.locator('[data-job]').first.check(); pg.wait_for_timeout(300); fill('[data-f="date"]',D)
        if not pg.input_value('[data-f="amount"]'): fill('[data-f="amount"]','1000')
        rec()
        while popup(): print('driver popup:', pg.inner_text('#phAsk h2')); pg.click('#phAsk [data-i="0"]'); pg.wait_for_timeout(400)
        ok('driver job marked Paid with the date', 'marked Paid on '+D in pg.inner_text('#ph_done'))
    # ---- loan
    pick('loan'); lv=pg.evaluate("[...document.querySelectorAll('#ph_loanId option')].filter(o=>o.value)[0].value"); pg.select_option('#ph_loanId',lv); pg.wait_for_timeout(200)
    fill('[data-f="month"]','2026-10'); pg.dispatch_event('[data-f="month"]','change'); pg.wait_for_timeout(300); fill('[data-f="date"]',D)
    if not pg.input_value('[data-f="amount"]'): fill('[data-f="amount"]','1000')
    rec()
    while popup(): print('loan popup:', pg.inner_text('#phAsk h2')); pg.click('#phAsk [data-i="0"]'); pg.wait_for_timeout(400)
    ok('loan instalment recorded', 'paid on '+D in pg.inner_text('#ph_done'))
    # ---- individual
    pick('individual'); fill('[data-f="person"]','LAWYER'); fill('[data-f="amount"]','10000'); fill('[data-f="date"]',D); rec()
    ok('individual paid', 'LAWYER' in pg.inner_text('#ph_done'))
    # ---- money in: rental via search
    pg.click('[data-dir="in"]'); pick('rental')
    rv=pg.evaluate("[...document.querySelectorAll('#ph_rentalId option')].filter(o=>o.value)[0].value"); pg.select_option('#ph_rentalId',rv); pg.wait_for_timeout(300)
    amt=pg.input_value('[data-f="amount"]'); ok('amount fills itself with what the rental owes', float(amt)>0)
    fill('[data-f="amount"]',str(float(amt)+500)); fill('[data-f="date"]',D); rec()
    ok('overpayment pop-up asks', popup() and 'More than' in pg.inner_text('#phAsk h2'))
    pg.click('#phAsk [data-i="0"]'); pg.wait_for_timeout(500); ok('rental paid, extra kept not linked', 'Paid' in pg.inner_text('#ph_done'))
    # ---- ochwada both ways
    pick('ochwada'); fill('[data-f="amount"]','3000'); fill('[data-f="date"]',D); rec(); ok('OCHWADA in', 'OCHWADA' in pg.inner_text('#ph_done'))
    # ---- filters
    pg.select_option('#ph_fcat',''); pg.select_option('#ph_fmonth','2026-10'); pg.select_option('#ph_fdir','out'); pg.wait_for_timeout(300)
    ok('Money out filter shows only OUT', pg.locator('#ph_list .ph-badge.in').count()==0 and pg.locator('#ph_list .ph-badge.out').count()>3)
    pg.select_option('#ph_fdir','in'); pg.wait_for_timeout(300); ok('Money in filter shows only IN', pg.locator('#ph_list .ph-badge.out').count()==0 and pg.locator('#ph_list .ph-badge.in').count()>=2)
    pg.select_option('#ph_fdir',''); pg.wait_for_timeout(200)
    ok('totals shown', 'In' in pg.inner_text('.ph-tot') and 'Out' in pg.inner_text('.ph-tot'))
    # ---- undo airport
    pg.select_option('#ph_fcat','Airport'); pg.wait_for_timeout(300); n0=pg.locator('#ph_list tbody tr').count()
    pg.locator('#ph_list [data-act="undo"]').first.click(); pg.wait_for_timeout(500); ok('undo removes the line', pg.locator('#ph_list tbody tr').count()<n0 or 'Nothing matches' in pg.inner_text('#ph_list'))
    # ---- edit received payment opens old form
    pg.select_option('#ph_fcat','Rental'); pg.select_option('#ph_fmonth',''); pg.wait_for_timeout(300)
    pg.locator('#ph_list [data-act="edit"]').first.click(); pg.wait_for_timeout(600); ok('edit a received payment opens the edit form', pg.locator('#oldPayForm').is_visible() and pg.input_value('#p_amount')!='')
    # ---- rentals paid tick opens hub with rental
    pg.click('.nav button[data-panel="rentals"]'); pg.wait_for_timeout(400)
    tick=pg.locator('#panel-rentals .paytick:not(:checked)').first
    if tick.count(): tick.click(); pg.wait_for_timeout(600); ok('paid tick on Rentals opens the payment form with the rental and amount', pg.evaluate("document.getElementById('panel-payments').classList.contains('active')") and float(pg.input_value('[data-f="amount"]') or 0)>0)
    # ---- Pilot shows dates
    pg.click('.nav button.sub[data-tab="loans"]'); pg.wait_for_timeout(500)
    ok('Loans due table has Paid on column with the date', 'paid on' in pg.inner_text('#panel-pilot').lower() and D in pg.inner_text('#panel-pilot') or '2026-10-20' in pg.inner_text('#panel-pilot'))
    print('console errors:', errs[:5])
    ok('no script errors', not errs)
finally:
  srv.terminate()
  try: os.remove(ROOT+'/test/harness.html')
  except: pass
print('FAILED:',bad) if bad else print('all browser checks passed')
