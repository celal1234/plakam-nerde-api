import dataSource from '../database/data-source';

// Yönetici rolü yalnızca sunucu üzerinden verilir; API'de kendini yönetici yapma ucu yoktur.
//   node dist/cli/admin.js grant <e-posta>       → yönetici yapar
//   node dist/cli/admin.js revoke <e-posta>      → yöneticiliği alır
//   node dist/cli/admin.js reset-mfa <e-posta>   → telefonunu kaybeden yöneticinin MFA'sını sıfırlar
const USAGE = 'Kullanım: node dist/cli/admin.js <grant|revoke|reset-mfa> <e-posta>';

async function main(): Promise<number> {
  const [command, email] = process.argv.slice(2);
  const sql: Record<string, string> = {
    grant: `UPDATE users SET role = 'admin' WHERE email = $1 AND deleted_at IS NULL RETURNING id`,
    revoke: `UPDATE users SET role = 'user', mfa_secret_enc = NULL WHERE email = $1 RETURNING id`,
    'reset-mfa': `UPDATE users SET mfa_secret_enc = NULL WHERE email = $1 AND role = 'admin' RETURNING id`,
  };
  if (!email || !sql[command]) {
    console.error(USAGE);
    return 2;
  }
  await dataSource.initialize();
  try {
    return await dataSource.transaction(async (tx) => {
      const [rows]: [{ id: string }[], number] = await tx.query(sql[command], [email]);
      if (!rows.length) {
        console.error(`Kullanıcı bulunamadı: ${email}`);
        return 1;
      }
      // Yetki değişince açık oturumlar kapanır; kullanıcı yeniden giriş yapar.
      await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [rows[0].id]);
      await tx.query(`INSERT INTO audit_log (action, target_type, target_id, meta) VALUES ($1, 'user', $2, $3)`, [
        `cli.admin.${command}`,
        rows[0].id,
        JSON.stringify({ via: 'cli' }),
      ]);
      console.log(`Tamam: ${command} ${email}`);
      return 0;
    });
  } finally {
    await dataSource.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
