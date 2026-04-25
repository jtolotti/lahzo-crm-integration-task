import bcrypt from 'bcrypt';

const password = process.argv[2];

if (!password) {
  console.error('Usage: npx tsx scripts/hash-password.ts <password>');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log(hash);
