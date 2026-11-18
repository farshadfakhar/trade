import bcrypt from 'bcryptjs';
const pw = process.argv[2];
if (!pw || pw.length < 12) { console.error('usage: npm run hash-password -- "<password of 12+ chars>"'); process.exit(1); }
console.log(`DASHBOARD_PASSWORD_HASH='${bcrypt.hashSync(pw, 12)}'`); // single quotes: Docker Compose would otherwise expand the $ signs
