// Creates the local database and its tables: npm run db:init
import { databaseFile, openDatabase } from './db.js'

const file = databaseFile()
const db = openDatabase(file)
const { n } = db.prepare('SELECT COUNT(*) AS n FROM leads').get()
console.log(`Database ready at ${file} (${n} lead${n === 1 ? '' : 's'}).`)
db.close()
