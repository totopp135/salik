// Self-test: simulates a user, a vehicle, a gate camera and a police report.
// Run the server first (npm start), then run this in a second window.
require('dotenv').config();
const BASE = 'http://localhost:' + (process.env.PORT || 3000) + '/api/v1';

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

let failures = 0;
function check(label, ok, extra = '') {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + label + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

(async () => {
  const gate = { 'x-gate-code': 'CAI-01', 'x-api-key': 'demo-gate-key' };
  const rnd = Math.floor(Math.random() * 1e7);
  const phone = '010' + String(rnd).padStart(8, '0');
  const plate = 'ABC ' + (1000 + (rnd % 9000));

  try {
    console.log('\n1) Register a user and link a car');
    const reg = await call('POST', '/app/auth/register', { full_name: 'Test Driver', phone, password: 'secret123' });
    const auth = { Authorization: 'Bearer ' + reg.token };
    await call('POST', '/app/vehicles', { plate, vehicle_type_id: 2 }, auth);
    check('User registered and car linked', true, `(plate ${plate})`);

    console.log('\n2) Top up the wallet with 100 EGP');
    const top = await call('POST', '/app/wallet/topup-demo', { amount: 100 }, auth);
    check('Balance is 100', Number(top.balance) === 100, `(balance ${top.balance})`);

    console.log('\n3) Car drives through the gate (toll for a car = 10 EGP)');
    const p1 = await call('POST', '/gate/passages', { plate, confidence: 0.95, method: 'ANPR' }, gate);
    check('Gate says OPEN and toll was paid', p1.action === 'OPEN' && p1.status === 'PAID', `(${p1.status})`);
    const w1 = await call('GET', '/app/wallet', null, auth);
    check('Balance is now 80', Number(w1.balance) === 80, `(balance ${w1.balance})`);
    await new Promise(r => setTimeout(r, 400));
    const notes = await call('GET', '/app/notifications', null, auth);
    check('User received a notification', notes.length >= 1, notes[0] ? `("${notes[0].title}")` : '');

    console.log('\n4) Unknown plate drives through');
    const p2 = await call('POST', '/gate/passages', { plate: 'ZZZ 9999', confidence: 0.95 }, gate);
    check('Gate opens, marked UNREGISTERED', p2.action === 'OPEN' && p2.status === 'UNREGISTERED');

    console.log('\n5) Driver with an empty wallet');
    const phone2 = '011' + String(rnd).padStart(8, '0');
    const plate2 = 'XYZ ' + (1000 + (rnd % 9000));
    const reg2 = await call('POST', '/app/auth/register', { full_name: 'Broke Driver', phone: phone2, password: 'secret123' });
    const auth2 = { Authorization: 'Bearer ' + reg2.token };
    await call('POST', '/app/vehicles', { plate: plate2, vehicle_type_id: 2 }, auth2);
    const p3 = await call('POST', '/gate/passages', { plate: plate2, confidence: 0.95 }, gate);
    check('Gate opens, status INSUFFICIENT_BALANCE', p3.action === 'OPEN' && p3.status === 'INSUFFICIENT_BALANCE');
    const viol = await call('GET', '/app/violations', null, auth2);
    check('A violation was recorded', viol.length === 1);

    console.log('\n6) Police report the first car as stolen');
    const adm = await call('POST', '/admin/auth/login', { email: 'admin@etoll.local', password: 'Admin123!' });
    const admAuth = { Authorization: 'Bearer ' + adm.token };
    await call('POST', '/admin/stolen-reports', { plate_number: plate, report_number: 'POL-' + rnd }, admAuth);
    const p4 = await call('POST', '/gate/passages', { plate, confidence: 0.95 }, gate);
    check('Gate returns OPEN_AND_FLAG', p4.action === 'OPEN_AND_FLAG');
    const alerts = await call('GET', '/admin/alerts', null, admAuth);
    check('Security alert appears on dashboard', alerts.some(a => a.plate_number === plate.replace(/\s/g, '')));

    console.log('\n' + (failures === 0
      ? 'ALL TESTS PASSED. Your backend works!'
      : failures + ' test(s) FAILED. Copy this whole window and send it to me.'));
  } catch (e) {
    console.error('\nERROR: ' + e.message);
    console.error('Is the server running in the other window (npm start)? If yes, copy this whole window and send it to me.');
    process.exitCode = 1;
  }
})();
