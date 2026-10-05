'use strict';
const sql = require('mssql');

const INSERT = `
INSERT INTO ext.DicksSellThrough
    (WeekEnding, Style, Description, UnitsSold, SalesDollars, OnHandUnits, OnHandDollars,
     InTransitUnits, OnOrderUnits, IsRefill, SourceFile, LoadedAt)
VALUES
    (@week, @style, @description, @unitsSold, @salesDollars, @onHandUnits, @onHandDollars,
     @inTransitUnits, @onOrderUnits, @isRefill, @sourceFile, SYSUTCDATETIME())`;

function config(env) {
  return {
    server: env.SQL_SERVER,
    database: env.SQL_DATABASE,
    user: env.SQL_USER,
    password: env.SQL_PASSWORD,
    options: { encrypt: true, useUTC: true },
    pool: { max: 1 },
    connectionTimeout: 30000,
    requestTimeout: 60000,
  };
}

const asDate = (iso) => new Date(`${iso}T00:00:00Z`);

function insert(tx, week, row, isRefill, sourceFile) {
  return new sql.Request(tx)
    .input('week', sql.Date, asDate(week))
    .input('style', sql.NVarChar(50), row.style)
    .input('description', sql.NVarChar(200), row.description ?? null)
    .input('unitsSold', sql.Int, row.unitsSold)
    .input('salesDollars', sql.Decimal(18, 2), row.salesDollars ?? null)
    .input('onHandUnits', sql.Int, row.onHandUnits ?? null)
    .input('onHandDollars', sql.Decimal(18, 2), row.onHandDollars ?? null)
    .input('inTransitUnits', sql.Int, row.inTransitUnits ?? null)
    .input('onOrderUnits', sql.Int, row.onOrderUnits ?? null)
    .input('isRefill', sql.Bit, isRefill)
    .input('sourceFile', sql.NVarChar(200), sourceFile)
    .query(INSERT);
}

// Write rules from the spec: replace week W in full; fill W-7/-14/-21 with units only, and only
// when that week has no rows at all.
async function writeWeek(env, parsed, sourceFile) {
  const pool = await new sql.ConnectionPool(config(env)).connect();
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    await new sql.Request(tx)
      .input('week', sql.Date, asDate(parsed.weekEnding))
      .query('DELETE FROM ext.DicksSellThrough WHERE WeekEnding = @week');
    for (const row of parsed.rows) await insert(tx, parsed.weekEnding, row, false, sourceFile);

    const byWeek = new Map();
    for (const r of parsed.refills) {
      if (!byWeek.has(r.weekEnding)) byWeek.set(r.weekEnding, []);
      byWeek.get(r.weekEnding).push(r);
    }
    const refilledWeeks = [];
    for (const [week, rows] of byWeek) {
      const result = await new sql.Request(tx)
        .input('week', sql.Date, asDate(week))
        .query('SELECT COUNT(*) AS n FROM ext.DicksSellThrough WHERE WeekEnding = @week');
      if (result.recordset[0].n > 0) continue;
      for (const row of rows) await insert(tx, week, row, true, sourceFile);
      refilledWeeks.push(week);
    }

    await tx.commit();
    return { inserted: parsed.rows.length, refilledWeeks };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    await pool.close().catch(() => {});
  }
}

module.exports = { writeWeek };
