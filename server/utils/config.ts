export function getServerConfig() {
  return {
    appUsername: process.env.APP_USERNAME || 'admin',
    appPasswordHash: process.env.APP_PASSWORD_HASH || '',
    adminFirstName: process.env.APP_ADMIN_FIRST_NAME?.trim() || '',
    adminLastName: process.env.APP_ADMIN_LAST_NAME?.trim() || '',
    adminEmail: process.env.APP_ADMIN_EMAIL?.trim() || '',
    // Legacy: only read once, to seed the default board during the boards migration.
    ascIssuerId: process.env.ASC_ISSUER_ID || '',
    ascKeyId: process.env.ASC_KEY_ID || '',
    ascAppId: process.env.ASC_APP_ID || '',
    ascPrivateKeyPath: process.env.ASC_PRIVATE_KEY_PATH || '',
    databasePath: process.env.DATABASE_PATH || './data/open-bugster.sqlite',
    attachmentsPath: process.env.ATTACHMENTS_PATH || './data/attachments'
  }
}
