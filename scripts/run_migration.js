const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');

// Read DATABASE_URL from .env.vercel directly
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env.vercel'), 'utf8');
const match = envContent.match(/^DATABASE_URL="?(.*?)"?$/m);
if (!match) {
  // Try without quotes
  const match2 = envContent.match(/^DATABASE_URL=(.*)$/m);
  if (!match2) {
    console.error('DATABASE_URL not found in .env.vercel');
    process.exit(1);
  }
  var dbUrl = match2[1].replace(/^"(.*)"$/, '$1');
} else {
  var dbUrl = match[1];
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema-v2.sql'), 'utf8');
  const sql = neon(dbUrl);
  
  const statements = [];
  let current = '';
  let dollarQuoted = false;
  for (let i = 0; i < schema.length; i++) {
    if (schema.slice(i, i + 2) === '$$') {
      dollarQuoted = !dollarQuoted;
      current += '$$';
      i++;
    } else if (schema[i] === ';' && !dollarQuoted) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += schema[i];
    }
  }
  if (current.trim()) statements.push(current.trim());

  console.log(`Executing ${statements.length} statements...`);
  
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (!stmt || stmt.length < 5) continue;
    try {
      await sql(stmt);
      console.log(`  [${i + 1}/${statements.length}] OK`);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.log(`  [${i + 1}/${statements.length}] SKIP (exists)`);
      } else {
        console.log(`  [${i + 1}/${statements.length}] ERR: ${msg.slice(0, 200)}`);
      }
    }
  }
  
  console.log('Migration complete');
}

main().catch(err => { console.error(err); process.exit(1); });