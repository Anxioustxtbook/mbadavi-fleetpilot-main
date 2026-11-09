/* "Performance by car": one line per car, so you can see how each car is doing. Used in the Overview (Pilot) and under Performance.
   Net = billed - fuel - allowance - sub-hire cost - sub-hire driver pay (same rule as the Net column of Performance). Fuel is the one total; tap it to trace it in the Fuel table. */
import { carPerformance } from './fuelCore.js';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function carPerfHtml(d, f, ctx){
  const from = (f && f.from) || '', to = (f && f.to) || '';
  const list = carPerformance(d, from, to).filter(o => o.rentals || o.fuel);
  const t = k => list.reduce((s, o) => s + o[k], 0), fmt = n => ctx.fmt(n), fleetNet = t('net');
  const fuelBtn = (v, extra) => v ? `<button type="button" class="pg-fig" data-fuelgo='${esc(JSON.stringify(Object.assign({ from, to }, extra)))}' title="Show where this fuel is traced">${fmt(v)}</button>` : fmt(0);
  return `<h3 style="margin:18px 0 6px;">Performance by car</h3><p class="subtitle">How each car is doing${from || to ? ' for pickups ' + esc(from || '…') + ' to ' + esc(to || '…') : ' (all dates)'}. Best net first. Fuel is the total used; tap it to see where it is traced.</p>
    <div class="table-wrap"><div class="table-scroll"><table class="pg-table" data-no-tools="1"><thead><tr><th>Car</th><th class="num">Rentals</th><th class="num">Days</th><th class="num">Billed</th><th class="num">Fuel used</th><th class="num">Allowance</th><th class="num">Sub-hire</th><th class="num">Driver pay</th><th class="num">Net</th><th class="num">Net / day</th><th class="num">Share of net</th></tr></thead><tbody>
    ${list.map(o => `<tr><td>${esc(o.reg)}${o.sub ? ' <span class="tag">sub-hire</span>' : ''}</td><td class="num">${o.rentals}</td><td class="num">${o.days}</td><td class="num">${fmt(o.billed)}</td><td class="num">${fuelBtn(o.fuel, { car: o.vehicleId })}</td><td class="num">${fmt(o.allowance)}</td><td class="num">${fmt(o.subhire)}</td><td class="num">${fmt(o.driver)}</td><td class="num"><b style="color:var(--${o.net < 0 ? 'red' : 'green'});">${fmt(o.net)}</b></td><td class="num">${o.days ? fmt(o.perDay) : '—'}</td><td class="num">${fleetNet > 0 && o.net > 0 ? Math.round(o.net / fleetNet * 100) + '%' : '—'}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="11">No rentals in these dates.</td></tr>'}</tbody>
    <tfoot><tr><th>FLEET</th><th class="num">${t('rentals')}</th><th class="num">${t('days')}</th><th class="num">${fmt(t('billed'))}</th><th class="num">${fuelBtn(t('fuel'), {})}</th><th class="num">${fmt(t('allowance'))}</th><th class="num">${fmt(t('subhire'))}</th><th class="num">${fmt(t('driver'))}</th><th class="num">${fmt(fleetNet)}</th><th class="num">${t('days') ? fmt(Math.round(fleetNet / t('days') * 100) / 100) : '—'}</th><th></th></tr></tfoot></table></div></div>`;
}
