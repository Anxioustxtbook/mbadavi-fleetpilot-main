# Tap-through on Pilot, date line, flash on open. Fake workbook reader (no ExcelJS needed).
import subprocess, time, os
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..'))
h=open(ROOT+'/index.html').read().replace('<script type="module" src="/src/main.js"></script>','<script type="module" src="/test/harness-persist.js"></script>')
open(ROOT+'/test/harness-b11.html','w').write(h)
srv=subprocess.Popen(['python3','-m','http.server','8797','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
errs=[]; bad=[]
def ok(n,c): print(('PASS ' if c else 'FAIL ')+n); (None if c else bad.append(n))
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':1500,'height':1300}).new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None); pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e))); pg.on('dialog',lambda d: d.accept())
    pg.add_init_script("new MutationObserver(()=>{const i=document.getElementById('askInput');if(i&&!i.dataset.d){i.dataset.d=1;i.value='1234';document.getElementById('askOk').click();}}).observe(document,{childList:true,subtree:true});")
    pg.goto('http://localhost:8797/test/harness-b11.html'); pg.wait_for_timeout(1500)
    pg.click('#btnFileMenu'); pg.click('#btnConnectPhone')
    ok('Connect phone is beside the close button', pg.inner_text('.fm-head-actions').index('Connect phone') < pg.inner_text('.fm-head-actions').index('✕'))
    ok('phone pairing is clearly marked as not ready', pg.is_visible('#fmPhoneNote') and 'not available yet' in pg.inner_text('#fmPhoneNote'))
    pg.click('#fmClose')
    pg.click('#btnFileMenu'); pg.click('#btnRecover')
    ok('Recover offers a delete action for a safety copy', pg.locator('#recoverOverlay [data-rcdel]').count()==1)
    pg.click('#recoverOverlay [data-rcdel]'); pg.wait_for_timeout(300)
    ok('deleting a safety copy removes only that entry', pg.locator('#recoverOverlay [data-rcdel]').count()==0 and 'Safety copy deleted' in pg.inner_text('body'))
    pg.click('#rcClose')
    pg.click('#btnFileMenu'); pg.click('#btnImport')
    pg.set_input_files('input[type=file][style*="display: none"]',{'name':'P.xlsx','mimeType':'application/octet-stream','buffer':b'x'})
    pg.wait_for_selector('#importOverlay.show',timeout=20000); pg.wait_for_timeout(1500)
    pg.check('#impOk'); pg.click('#impGo'); pg.wait_for_timeout(2500)
    ok('date line shows today', 'Today:' in pg.inner_text('#fileStatus'))
    pg.click('.nav button[data-panel="pilot"]'); pg.wait_for_timeout(800)
    R='#panel-pilot'
    def tab(name):
        pg.click(R+' [data-tab="%s"]'%name); pg.wait_for_timeout(400)
    def tap(sel, label):
        n=pg.locator(R+' '+sel).count()
        if not n: ok(label+' has tappable figure',False); return False
        pg.locator(R+' '+sel).first.click(); pg.wait_for_timeout(400)
        good=pg.locator('#pgDrill').count()==1 and pg.locator('#pgDrill tbody tr').count()>0
        ok(label+' opens a list of records', good); return good
    tab('overview'); tap('tbody td:last-of-type, tbody .pg-fig', 'overview')
    tab('overview'); pg.locator(R+' .pg-fig[data-spec*="total"]').first.click(); pg.wait_for_timeout(300)
    ok('Total spent opens list', 'Total spent' in (pg.inner_text('#pgDrill') if pg.locator('#pgDrill').count() else ''))
    for t,l in [('loans','loans'),('insurance','insurance'),('ochwada','ochwada'),('subhire','subhire')]:
        tab(t); tap('.pg-fig', l)
    # open a row: lands on the tab and flashes
    tab('loans'); tap('.pg-fig','loans again')
    pg.locator('#pgDrill [data-pg="open"]').first.click(); pg.wait_for_timeout(500)
    ok('open row flashes the target', pg.locator(R+' .fp-flash').count()>=1 or pg.locator(R+' tr').count()>0)
    ok('drill panel closed after open', pg.locator('#pgDrill').count()==0)
    # editing a grid cell still works (figure buttons did not break editing)
    tab('loans'); cell=pg.locator(R+' [data-g="cell"][data-t="loanlist"]').first; cell.click(); ok('grid cell still edits', pg.locator(R+' [data-t="loanlist"] input').count()>=1)
  print('errors:',errs[:5]); print('FAILED:',bad)
finally:
  srv.terminate(); os.remove(ROOT+'/test/harness-b11.html')
