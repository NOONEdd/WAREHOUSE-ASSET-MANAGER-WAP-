"""Self-test of o06-data-quality.sql against a SYNTHETIC database (decision O-06).

Never touches a real database. It builds a fresh SQLite file from the desktop
schema (src/main/database/schema.sql, read only), fills it with invented rows
that contain known data-quality problems, then runs the assessment script the
way the runbook does — opened read-only and immutable — and checks:

  * the database file is byte-identical afterwards, and the script contains only
    SELECT statements plus PRAGMA query_only = ON;
  * after the script, the connection refuses writes (query_only);
  * the report never contains a synthetic asset name, code, serial number,
    username, person name, note, lookup name or the file path, and every text
    value it prints from the data is one of the kinds the script's header lists;
  * the counts the script reports match the planted problems;
  * the script stops at once — before reading any data — when query_only is off,
    when the file still has the live name, when it lies in an application-data
    folder, or when it is not a WAM desktop database.

Run (Python 3.9+, standard library only):  python3 -I tools/data-quality/test_o06_data_quality.py
"""

import hashlib
import re
import pathlib
import shutil
import sqlite3
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SCRIPT = HERE / 'o06-data-quality.sql'
DESKTOP_SCHEMA = ROOT / 'src' / 'main' / 'database' / 'schema.sql'

SENSITIVE: list[str] = []  # every invented value that must never appear in the report


def build_synthetic(path: pathlib.Path) -> None:
    db = sqlite3.connect(path)
    db.executescript(DESKTOP_SCHEMA.read_text(encoding='utf-8'))
    db.execute('PRAGMA foreign_keys = OFF')  # to plant one broken reference below
    lookups = {
        'item_types': ['Synthetic type Alpha', 'Synthetic type Beta'],
        'workshops': ['Synthetic unit North', 'Synthetic unit South', 'Synthetic unit Closed'],
        'countries': ['Synthetic land'],
    }
    for table, names in lookups.items():
        for name in names:
            db.execute(f'INSERT INTO {table} (name) VALUES (?)', (name,))
            SENSITIVE.append(name)
    db.execute("UPDATE workshops SET is_active = 0 WHERE name = 'Synthetic unit Closed'")
    for i, (username, full_name) in enumerate([('synth.keeper', 'Synthetic Keeper Person'), ('synth.clerk', 'Synthetic Clerk Person')]):
        db.execute('INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, ?, ?, ?)', (username, 'x' * 60, full_name, 1 + i))
        SENSITIVE.extend([username, full_name])
    # A legacy status (as migration 001 knew it) and a Latin-named one, both inactive.
    db.execute("INSERT INTO asset_statuses (name, is_active, sort_order) VALUES ('تعمیر', 0, 5), ('Repair', 0, 6)")

    def asset(code, serial, *, status=1, workshop=1, entry=None, exit_=None, deleted=0, deleted_at=None, name=None, note=None):
        name = name or f'Synthetic asset {code}'
        db.execute(
            '''INSERT INTO assets (asset_code, asset_name, item_type_id, serial_number, workshop_id, status_id,
                                   warehouse_entry_date, warehouse_exit_date, is_deleted, deleted_at, notes)
               VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (code, name, serial, workshop, status, entry, exit_, deleted, deleted_at, note),
        )
        SENSITIVE.extend([v for v in (code, name, note) if v])
        if len(serial.strip()) >= 3:
            SENSITIVE.append(serial.strip())
        return db.execute('SELECT last_insert_rowid()').fetchone()[0]

    normal = []
    for i in range(50):
        entry = '1402/05/10' if i < 20 else ('2023-08-01' if i < 40 else None)
        normal.append(asset(f'C-{1000 + i}', f'SNX-{i + 1:04d}', entry=entry, note=f'Synthetic note {i}'))
    # Planted problems (all active unless stated).
    asset('C-2001', '0000')                      # P1, P7, digits only, leading zero
    asset('C-2002', '----')                      # P1, P3
    asset('C-2003', 'ندارد')                     # P4, Persian letters
    asset('C-2004', 'N/A')                       # P4
    asset('C-2005', 'TEMP-17')                   # P5
    asset('C-2006', 'C-2006')                    # P6
    asset('C-2007', '7')                         # P1, P2, P7, digits only
    asset('C-2008', '  SPACE-SN  ')              # leading/trailing spaces
    asset('C-2009', '00123', entry='۱۴۰۲/۰۵/۱۰')  # digits only, leading zero; Persian-digit date
    asset('C-2010', '۱۲۳۴۵۶', entry='45123')      # Persian digits; near-duplicate of the next; bare-number date
    asset('C-2011', '123456', entry='10/08/2023')  # digits only; ambiguous date
    asset('C-2012', 'AB-12 34', entry='2023-08-10', exit_='2023-08-01')  # near-duplicate of the next; exit before entry
    asset('C-2013', 'ab1234')
    asset('C-2014', 'ي-99')                      # Arabic yeh: near-duplicate of the next; Persian/Arabic letters
    asset('C-2015', 'ی99')                       # Persian yeh; Persian/Arabic letters
    asset('C-2016', '')                          # blank
    asset('C-2017', '‌')                    # blank (zero-width non-joiner only)
    asset('C-2018', 'SNX-ORPHAN', workshop=999)  # broken reference to workshops
    asset('C-2019', 'SNX-INACTIVE', status=5)    # active asset in the inactive legacy status
    # Soft-deleted: one reuses an active serial and code, one lacks deleted_at.
    asset('C-1000', 'SNX-0001', deleted=1, deleted_at='2024-01-01 10:00:00', name='Synthetic deleted twin')
    asset('C-3001', 'SNX-GONE-1', deleted=1, deleted_at='2024-01-02 10:00:00')
    asset('C-3002', 'SNX-GONE-2', deleted=1, deleted_at=None)
    # History: one entry per normal asset; five of them later changed status without an entry (review F-3).
    for asset_id in normal:
        db.execute('INSERT INTO asset_transactions (asset_id, previous_status_id, new_status_id, performed_by_user_id) VALUES (?, NULL, 1, 1)', (asset_id,))
    db.execute('DROP TRIGGER update_assets_timestamp')  # keeps the planted rows exactly as written
    db.execute(f'UPDATE assets SET status_id = 2 WHERE id IN ({",".join(str(x) for x in normal[:5])})')
    db.execute("INSERT INTO audit_log (username_snapshot, action, entity_type, entity_id, changes) VALUES ('synth.keeper', 'create', 'asset', 1, '{}')")
    db.commit()
    db.close()


def statements(sql: str):
    """The script's SQL statements, as the sqlite3 shell would run them (dot-commands skipped)."""
    buffer = ''
    for line in sql.splitlines(keepends=True):
        if line.startswith('.') and code_of(buffer) == '':
            continue
        buffer += line
        if sqlite3.complete_statement(buffer):
            yield buffer.strip()
            buffer = ''
    assert buffer.strip() == '' or all(l.strip().startswith('--') or not l.strip() for l in buffer.splitlines()), 'trailing incomplete statement'


def code_of(statement: str) -> str:
    return '\n'.join(l for l in statement.splitlines() if not l.strip().startswith('--')).strip()


def run(path: pathlib.Path, script: str | None = None):
    uri = f'file:{path.as_posix()}?mode=ro&immutable=1'
    db = sqlite3.connect(uri, uri=True)
    results = []
    for statement in statements(script if script is not None else SCRIPT.read_text(encoding='utf-8')):
        code = code_of(statement)
        head = code.split(None, 1)[0].upper()
        assert head in ('SELECT', 'WITH') or code == 'PRAGMA query_only = ON;', f'not read-only: {code[:60]}'
        cursor = db.execute(code)
        columns = [d[0] for d in cursor.description] if cursor.description else []
        results.append((code, columns, cursor.fetchall()))
    return db, results


def value(results, label, column=1):
    """The value in `column` of the first result row whose first cell equals `label`."""
    for _, _, rows in results:
        for row in rows:
            if row and row[0] == label:
                return row[column]
    raise AssertionError(f'no row labelled {label!r}')


def main() -> int:
    work = pathlib.Path(tempfile.mkdtemp(prefix='wam-o06-selftest-'))
    try:
        copy = work / 'wam-copy-synthetic.db'
        build_synthetic(copy)
        before = hashlib.sha256(copy.read_bytes()).hexdigest()
        db, results = run(copy)

        # Writes are refused on this connection after the script.
        try:
            db.execute('CREATE TEMP TABLE probe (x)')
            raise AssertionError('query_only did not block a write')
        except sqlite3.OperationalError as err:
            assert 'readonly' in str(err).lower() or 'read-only' in str(err).lower() or 'query_only' in str(err).lower(), err
        db.close()
        assert hashlib.sha256(copy.read_bytes()).hexdigest() == before, 'database file changed'
        assert sorted(p.name for p in work.iterdir()) == ['wam-copy-synthetic.db'], 'side files were created'

        # Only what came out of the database: every printed cell except the script's own labels
        # (string literals written in the script, such as "e.g. 0000, xxxx, ----").
        literals = {lit for code, _, _ in results for lit in re.findall(r"'((?:[^']|'')*)'", code)}
        printed = [cell for _, columns, rows in results for row in rows for cell in row]
        from_data = [cell for cell in printed if not (isinstance(cell, str) and cell.replace("'", "''") in literals)]
        text_from_data = sorted({cell for cell in from_data if isinstance(cell, str)})
        allowed = {'ok'} | {name for (name,) in sqlite3.connect(copy).execute('SELECT name FROM asset_statuses UNION SELECT name FROM roles')}
        allowed |= {row[0] for row in sqlite3.connect(copy).execute("SELECT name FROM sqlite_master")} | {'wal', 'delete', 'yes', 'no'}
        allowed |= {sqlite3.sqlite_version}
        allowed |= {v for row in sqlite3.connect(copy).execute('SELECT DISTINCT action, entity_type FROM audit_log') for v in row}
        number = re.compile(r'^\d+(\.\d)?$')
        timestamp = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$')
        unexpected = [t for t in text_from_data if t not in allowed and not number.match(t) and not timestamp.match(t)]
        assert unexpected == [], f'unexpected text printed from the data: {unexpected}'
        report = repr(from_data)
        for secret in SENSITIVE + [str(work), copy.name]:
            assert secret not in report, f'report leaks {secret!r}'

        # Planted facts.
        active = 50 + 19
        assert value(results, 'assets') == 50 + 19 + 3
        three = next(rows for code, cols, rows in results if 'unexpected_is_deleted_values' in cols)[0]
        assert three == (active + 3, active, 3, 0, 1, 0), three
        warehouse = next(rows for code, cols, rows in results if 'warehouse_columns_in_assets' in cols)[0]
        assert warehouse[:3] == (0, active, active), warehouse
        assert value(results, 'serial_number') == 2 and value(results, 'serial_number', 2) == active
        assert value(results, 'blank serial (would have been an invented placeholder or an error)') == 2
        assert value(results, 'distinct serial values used by more than one active asset (exact)') == 0
        assert value(results, 'active assets whose serial also appears on a soft-deleted asset') == 1
        assert value(results, 'serial with leading or trailing spaces/invisible characters') == 2  # '  SPACE-SN  ' and the ZWNJ-only value
        assert value(results, 'serial made of ASCII digits only') == 4  # 0000, 7, 00123, 123456
        assert value(results, '… of which start with 0 (leading zeros must be preserved)') == 2
        assert value(results, 'serial containing Persian digits (۰–۹)') == 1
        assert value(results, 'serial containing Persian/Arabic letters') == 3
        groups = next(rows for code, cols, rows in results if cols[:1] == ['heuristic'])[0]
        assert groups == ('groups of differently written serials that look the same', 3, 6), groups
        rules = {row[0]: row[2] for code, cols, rows in results if cols[:1] == ['rule'] for row in rows}
        # Rules overlap: 'ندارد' is both a placeholder word (P4) and a placeholder prefix (P5). The seven
        # planted placeholder rows are 0000, ----, ندارد, N/A, TEMP-17, the code-copied serial and 7.
        assert rules == {'P1': 3, 'P2': 1, 'P3': 1, 'P4': 2, 'P5': 2, 'P6': 1, 'P7': 2, 'any': 7}, rules
        assert value(results, 'active assets whose code also appears on a soft-deleted asset') == 1
        statuses = {row[1]: row for code, cols, rows in results if cols[:2] == ['status_id', 'status_name'] for row in rows}
        assert statuses['تعمیر'][4:] == ('no', 'no', 1, 0, 0), statuses['تعمیر']
        assert statuses['Repair'][5] == 'yes'
        assert statuses['در انبار'][6] == active - 5 - 1, statuses['در انبار']
        assert value(results, 'active assets in an inactive status') == 1
        assert value(results, 'active assets with no status-history entry') == active - 50
        assert value(results, 'active assets whose latest history entry differs from the current status') == 5
        formats = {(row[0], row[1]): row[2] for code, cols, rows in results if cols[:2] == ['field', 'format'] for row in rows}
        assert formats[('warehouse_entry_date', '1 YYYY-MM-DD, year 13xx–14xx (looks Jalali)')] == 20
        assert formats[('warehouse_entry_date', '2 YYYY-MM-DD, year 19xx–20xx (looks Gregorian)')] == 21
        assert formats[('warehouse_entry_date', '5 contains Persian/Arabic digits')] == 1
        assert formats[('warehouse_entry_date', '4 a bare number (spreadsheet serial date?)')] == 1
        assert formats[('warehouse_entry_date', '3 DD-MM-YYYY or MM-DD-YYYY (ambiguous)')] == 1
        assert value(results, 'exit date before entry date (both YYYY-MM-DD, same calendar range)') == 1
        integrity = next(rows for code, cols, rows in results if cols == ['integrity_check_result'])
        assert integrity == [('ok',)], integrity
        broken = [row for code, cols, rows in results if cols[:1] == ['child_table'] for row in rows]
        assert broken == [('assets', 'workshops', 1)], broken
        assert results[-1][2] == [('end of report', 1)]

        # The refusals: each stops the run at its own check, before any data is read.
        def refused(path: pathlib.Path, script: str | None = None) -> str:
            try:
                run(path, script)
            except sqlite3.OperationalError as err:
                assert '$ STOP:' in str(err), err
                return str(err)
            raise AssertionError(f'not refused: {path}')

        live = work / 'asset-warehouse.db'
        shutil.copy(copy, live)
        assert 'named like the live desktop database' in refused(live)
        for folder in ('Users/someone/AppData/Roaming/wam', 'home/someone/.config/wam', 'Users/someone/Library/Application Support/wam'):
            inside = work / folder / 'wam-copy.db'
            inside.parent.mkdir(parents=True)
            shutil.copy(copy, inside)
            assert 'inside an application-data folder' in refused(inside), folder
        other = work / 'other.db'
        sqlite3.connect(other).execute('CREATE TABLE something_else (x)').connection.commit()
        assert 'not a WAM desktop database' in refused(other)
        without_guard = SCRIPT.read_text(encoding='utf-8').replace('PRAGMA query_only = ON;', '', 1)
        assert 'query_only is off' in refused(copy, without_guard)
        assert hashlib.sha256(copy.read_bytes()).hexdigest() == before, 'database file changed by the refusal runs'

        print(f'o06 self-test passed: {len(results)} statements, report free of {len(SENSITIVE)} synthetic values, file unchanged, 6 unsafe inputs refused')
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
