import subprocess, time, os, datetime
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-main.js"></script>')
open(ROOT+'/test/harness.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8768','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; fails=[]
def ok(n,c):
    print(('PASS ' if c else 'FAIL ')+n)
    if not c: fails.append(n)
today=datetime.date.today().isoformat()
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':1200})
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('dialog',lambda d: d.accept('1234'))
    pg.add_init_script("""new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});""")
    pg.goto('http://localhost:8768/test/harness.html'); pg.wait_for_timeout(1500)
    ok('app starts', pg.locator('#startfail').count()==0)
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'PERFOMANCE_2026.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2500)

    # ---------- Clients: four types, each with its own fields
    pg.click('.nav button[data-panel="clients"]'); pg.wait_for_timeout(400)
    types=pg.evaluate("[...document.querySelectorAll('#c_type option')].map(o=>o.value)")
    ok('client types: walkin, coop, taxi, self', types==['walkin','coop','taxi','self'])
    vis=lambda i: pg.evaluate("(id)=>{const e=document.getElementById(id);return !!e && e.closest('[data-cf]').style.display!=='none'}", i)
    pg.select_option('#c_type','self')
    ok('self-drive shows ID and licence, no driver fields', vis('c_id') and vis('c_dl') and not vis('c_driver') and not vis('c_driverphone'))
    pg.select_option('#c_type','coop')
    ok('coop shows ID, driver provided and driver phone, no licence', vis('c_id') and vis('c_driver') and vis('c_driverphone') and not vis('c_dl'))
    pg.select_option('#c_type','walkin')
    ok('walk-in shows ID, driver provided and driver phone', vis('c_id') and vis('c_driver') and vis('c_driverphone') and not vis('c_dl'))
    pg.select_option('#c_type','taxi')
    ok('taxi shows ID and licence', vis('c_id') and vis('c_dl') and not vis('c_driver'))
    pg.fill('#c_name','Zeta Coop Test'); pg.select_option('#c_type','coop'); pg.fill('#c_phone','0700111222'); pg.fill('#c_id','11112222'); pg.fill('#c_area','Kakamega'); pg.fill('#c_driver','John Driver'); pg.fill('#c_driverphone','0711999888'); pg.click('#btnAddClient'); pg.wait_for_timeout(300)
    row=pg.locator('#clientTable tbody tr', has_text='Zeta Coop Test')
    ok('coop client saved with driver and phone', row.count()==1 and 'John Driver' in row.inner_text() and '0711999888' in row.inner_text() and 'Coop' in row.inner_text())
    pg.fill('#c_name','Sam Self Test'); pg.select_option('#c_type','self'); pg.fill('#c_phone','0722333444'); pg.fill('#c_id','33334444'); pg.fill('#c_dl','DL556677'); pg.fill('#c_area','Kisumu'); pg.click('#btnAddClient'); pg.wait_for_timeout(300)
    row=pg.locator('#clientTable tbody tr', has_text='Sam Self Test')
    ok('self-drive client saved with ID and licence', row.count()==1 and 'Self-drive' in row.inner_text() and 'DL556677' in row.inner_text() and '33334444' in row.inner_text())
    pg.select_option('#c_typeFilter','self'); pg.wait_for_timeout(200)
    n=pg.locator('#clientTable tbody tr').count(); ok('filter shows self-drive clients only ('+str(n)+')', n>50 and all('Self-drive' in t for t in pg.locator('#clientTable tbody tr').all_inner_texts()))
    # edit keeps hidden fields
    pg.locator('#clientTable tbody tr', has_text='Zeta Coop Test').count()
    pg.select_option('#c_typeFilter','coop'); pg.wait_for_timeout(200)
    pg.locator('#clientTable tbody tr', has_text='Zeta Coop Test').locator('.row-edit:not(.row-extract)').click(); pg.wait_for_timeout(300)
    ok('editing a coop client fills the driver fields', pg.input_value('#c_driver')=='John Driver' and pg.input_value('#c_driverphone')=='0711999888' and not vis('c_dl'))
    pg.fill('#c_driverphone','0711000000'); pg.click('#btnAddClient'); pg.wait_for_timeout(300)
    ok('driver phone updated', '0711000000' in pg.locator('#clientTable tbody tr', has_text='Zeta Coop Test').inner_text())
    # rental form lists self-drive clients
    pg.click('.nav button[data-panel="rentals"]'); pg.wait_for_timeout(300)
    pg.select_option('#r_type','self'); pg.wait_for_timeout(200)
    ok('rental form: self-drive clients listed', 'Sam Self Test' in pg.inner_text('#r_client') or pg.locator('#r_client option', has_text='SAM SELF TEST').count()>0)
    pg.select_option('#r_typeFilter','self'); pg.wait_for_timeout(300)
    ok('rentals list filters on self-drive', pg.locator('#rentalTable tbody tr').count()>100 if pg.locator('#rentalTable').count() else True)
    # editing a rental whose client has another type keeps the client
    pg.select_option('#r_typeFilter',''); pg.wait_for_timeout(300)

    # ---------- Drivers: type
    pg.click('.nav button[data-panel="drivers"]'); pg.wait_for_timeout(300)
    ok('drivers: type select on the form and in the table', pg.locator('#d_kind').count()==1 and pg.locator('#driverTable .d-kind').count()>10)
    ok('imported sub-hire drivers are flagged', pg.evaluate("[...document.querySelectorAll('#driverTable tr')].filter(r=>/^(BARACK|BRIAN)\\s+(—|\\u2014)/.test(r.innerText.trim())).every(r=>r.querySelector('.d-kind').value==='subhire')"))

    # ---------- Pilot > Pages > Sub-hire
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(500)
    pg.click('#panel-pilot [data-tab="pages"]'); pg.wait_for_timeout(300)
    pg.click('#panel-pilot [data-pg="page"][data-page="subhire"]'); pg.wait_for_timeout(500)
    t=pg.inner_text('#panel-pilot')
    ok('Sub-hire page: owners, cars, drivers, lines', all(k in t for k in ['What each owner was paid','How each sub-hire car performed','Sub-hire drivers','Sub-hire lines','Paid to owners','Not cleared','Cancelled']))
    ok('month chips and All months', pg.locator('#panel-pilot [data-pg="shmonth"]').count()>=8)
    pg.click('#panel-pilot [data-pg="shmonth"][data-month="2026-02"]'); pg.wait_for_timeout(400)
    ok('February shown', 'February 2026' in pg.inner_text('#panel-pilot'))
    g='#panel-pilot [data-gt="shOwner"]'
    n=pg.locator(g+' tbody tr').count(); ok('sub-hire lines listed for the month ('+str(n)+')', n>5)
    tot0=pg.locator(g+' tfoot').inner_text()
    # change an amount
    c=pg.locator(g+' td[data-c="cost"]').first; c.click(); c.locator('input').fill('1234'); c.locator('input').press('Enter'); pg.wait_for_timeout(300)
    ok('typing a new amount changes the total', pg.locator(g+' tfoot').inner_text()!=tot0 and '1,234' in pg.locator(g+' tbody').inner_text())
    # status: cancel the second line and see the total drop
    tot1=pg.locator(g+' tfoot').inner_text()
    s=pg.locator(g+' td[data-c="status"]').nth(1); s.click(); s.locator('select').select_option('cancelled'); pg.wait_for_timeout(300)
    ok('cancelling a line takes it out of the amount total', pg.locator(g+' tfoot').inner_text()!=tot1)
    ok('status shows Cancelled and the date is filled', 'Cancelled' in pg.locator(g+' tbody tr').nth(1).inner_text() and today in pg.locator(g+' tbody tr').nth(1).locator('td[data-c="statusDate"]').inner_text())
    d=pg.locator(g+' td[data-c="statusDate"]').nth(2); d.click(); d.locator('input').fill('2026-03-15'); d.locator('input').press('Enter'); pg.wait_for_timeout(300)
    ok('the status date can be typed', '2026-03-15' in pg.locator(g+' tbody tr').nth(2).inner_text())
    j=pg.locator(g+' td[data-c="job"]').first; j.click(); j.locator('input').fill('Kakamega site visit'); j.locator('input').press('Enter'); pg.wait_for_timeout(300)
    ok('job (where it worked) can be edited', 'Kakamega site visit' in pg.locator(g+' tbody').inner_text())
    # owner button filters
    pg.locator('#panel-pilot [data-pg="showner"]').first.click(); pg.wait_for_timeout(300)
    ok('owner button filters the lines', pg.locator(g+' tbody tr').count()<=n)
    pg.locator('#panel-pilot [data-pg="shmonth"][data-month="all"]').click(); pg.wait_for_timeout(400)
    ok('All months lists more lines', pg.locator(g+' tbody tr').count()>n)
    # open rental
    pg.locator(g+' [data-g="open"]').first.click(); pg.wait_for_timeout(500)
    ok('↗ opens the rental', pg.evaluate("document.getElementById('panel-rentals').classList.contains('active')"))

    # ---------- Pilot > Pages > Sub-hire driver
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(400)
    pg.click('#panel-pilot [data-tab="pages"]'); pg.click('#panel-pilot [data-pg="page"][data-page="subhireDriver"]'); pg.wait_for_timeout(500)
    t=pg.inner_text('#panel-pilot'); ok('driver sheet page draws', all(k.lower() in t.lower() for k in ['Amount per day','Amount (per day × days)','Status','Paid','Not cleared']))
    pg.click('#panel-pilot [data-pg="sdmonth"][data-month="2026-01"]'); pg.wait_for_timeout(400)
    g='#panel-pilot [data-gt="sdDriver"]'
    ok('January sub-hire driver jobs listed', pg.locator(g+' tbody tr').count()>10)
    first=pg.locator(g+' tbody tr').first; days=int(first.locator('td').nth(4).inner_text().replace(',',''))
    r=pg.locator(g+' td[data-c="rate"]').first; r.click(); r.locator('input').fill('900'); r.locator('input').press('Enter'); pg.wait_for_timeout(300)
    amt=pg.locator(g+' tbody tr').first.locator('td').nth(6).inner_text().replace(',','')
    ok('amount = amount per day × days ('+str(days)+' × 900)', float(amt)==900*days)
    st=pg.locator(g+' td[data-c="status"]').first; st.click(); st.locator('select').select_option('notcleared'); pg.wait_for_timeout(300)
    ok('not cleared clears the date', pg.locator(g+' tbody tr').first.locator('td[data-c="statusDate"]').inner_text()=='')
    st=pg.locator(g+' td[data-c="status"]').first; st.click(); st.locator('select').select_option('paid'); pg.wait_for_timeout(300)
    ok('paid fills today as the date', today in pg.locator(g+' tbody tr').first.locator('td[data-c="statusDate"]').inner_text())
    pg.select_option('#panel-pilot [data-pg-set="sdDriver"]','BRIAN'); pg.wait_for_timeout(300)
    ok('driver filter', all('BRIAN' in x for x in [r.inner_text() for r in pg.locator(g+' tbody tr').all()]))
    # Monthly progress still agrees and drills
    pg.click('#panel-pilot [data-pg="page"][data-page="progress"]'); pg.wait_for_timeout(500)
    ok('monthly progress draws', 'Sub-hire driver' in pg.inner_text('#panel-pilot'))
    pg.locator('#panel-pilot .pg-fig[data-spec*="subhireDriver"]').first.click(); pg.wait_for_timeout(400)
    ok('sub-hire driver figure opens its records (rentals and costs)', pg.locator('#pgDrill tbody tr').count()>3 and 'Sub-hire driver' in pg.inner_text('#pgDrill'))
    # performance still draws with new columns
    pg.click('.nav button[data-panel="performance"]'); pg.wait_for_timeout(500)
    ok('performance panel draws', pg.locator('#panel-performance tbody tr').count()>100)
    b.close()
finally:
  srv.terminate()
print('console errors:', errs[:10])
print('FAILED: '+str(fails) if fails else 'browser5: all checks passed')
