// Creates the local database and its tables: npm run db:init
import { openDatabase } from './db.js'

const file = process.env.DATABASE_FILE || 'data/dealsaathi.db'
const db = openDatabase(file)
const { n } = db.prepare('SELECT COUNT(*) AS n FROM leads').get()
console.log(`Database ready at ${file} (${n} lead${n === 1 ? '' : 's'}).`)
db.close()
