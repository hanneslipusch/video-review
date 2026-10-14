"""A tiny projects-and-todos app whose variants plant backend changes the screen does not show.

VARIANT is a comma list of: n_plus_one, count_bug, webhook, sort_by_open. Spans go only to SPANS_FILE.
"""

import html
import json
import os
import sqlite3
import urllib.request
from pathlib import Path

import logfire
from fastapi import FastAPI, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor

VARIANT = set(filter(None, os.environ.get('VARIANT', '').split(',')))
DB = Path(os.environ['DB_FILE'])
spans = open(os.environ['SPANS_FILE'], 'a', buffering=1)

# Local only, nothing leaves this machine: https://pydantic.dev/docs/logfire/api/logfire/
logfire.configure(
    send_to_logfire=False,
    console=False,
    service_name='reviewability-app',
    additional_span_processors=[SimpleSpanProcessor(ConsoleSpanExporter(out=spans, formatter=lambda s: s.to_json(indent=None) + '\n'))],
)
logfire.instrument_sqlite3()
app = FastAPI()
logfire.instrument_fastapi(app)

PROJECTS = [
    ('Alder Creek Solar', 'Mara Weiss'), ('Birchfield Storage', 'Jonas Berg'), ('Cedar Ridge Wind', 'Lena Huber'),
    ('Dunmore Substation', 'Tobias Kern'), ('Elm Valley Solar', 'Mara Weiss'), ('Fernhill Battery', 'Sofia Lang'),
    ('Granite Pass Wind', 'Jonas Berg'), ('Hazel Grove Solar', 'Lena Huber'), ('Ironwood Grid Link', 'Tobias Kern'),
    ('Juniper Flats Solar', 'Sofia Lang'),
]
OPEN_TASKS = [3, 1, 5, 2, 0, 4, 2, 6, 1, 3]


def seed() -> None:
    DB.unlink(missing_ok=True)
    db = sqlite3.connect(DB)
    db.executescript('''
        create table users (id integer primary key, name text);
        create table projects (id integer primary key, name text, owner_id integer);
        create table todos (id integer primary key, project_id integer, title text, done integer default 0);
        create table notifications (id integer primary key, user_id integer, read integer default 0);
    ''')
    owners = sorted({owner for _, owner in PROJECTS})
    db.cursor().executemany('insert into users (id, name) values (?, ?)', enumerate(owners, 1))
    for pid, ((name, owner), count) in enumerate(zip(PROJECTS, OPEN_TASKS), 1):
        db.cursor().execute('insert into projects values (?, ?, ?)', (pid, name, owners.index(owner) + 1))
        db.cursor().executemany('insert into todos (project_id, title) values (?, ?)', [(pid, f'Task {n + 1}') for n in range(count)])
    db.cursor().execute("update todos set title = 'Write the report' where project_id = 1 and title = 'Task 1'")
    db.cursor().execute('delete from todos where project_id = 1 and title != ?', ('Write the report',))
    db.cursor().executemany('insert into notifications (user_id) values (?)', [(1,), (1,)])
    db.commit()


def connect() -> sqlite3.Connection:
    return sqlite3.connect(DB)


def page(title: str, body: str, db: sqlite3.Connection) -> HTMLResponse:
    user = db.cursor().execute('select name from users where id = 1').fetchone()[0]
    unread = db.cursor().execute('select count(*) from notifications where user_id = 1 and read = 0').fetchone()[0]
    return HTMLResponse(f'''<!doctype html><html><head><title>{html.escape(title)}</title><style>
      body {{ font: 22px system-ui, sans-serif; margin: 0; color: #1f2933; background: #f6f7f9 }}
      header {{ display: flex; justify-content: space-between; padding: 14px 32px; background: #1f2933; color: #fff }}
      main {{ padding: 16px 32px }} h1 {{ font-size: 30px; margin: 4px 0 12px }}
      table {{ border-collapse: collapse; width: 100%; background: #fff }}
      td, th {{ text-align: left; padding: 6px 12px; border-bottom: 1px solid #e3e6ea }}
      a {{ color: #1557b0; text-decoration: none }} .done {{ text-decoration: line-through; color: #8a94a0 }}
      li {{ list-style: none; padding: 8px 0; border-bottom: 1px solid #e3e6ea; background: #fff; padding-left: 12px }}
      ul {{ padding: 0 }} input[type=text] {{ font: inherit; padding: 6px; width: 420px }} button {{ font: inherit }}
      footer {{ margin-top: 10px; color: #52606d }}
    </style></head><body><header><b>Fieldplan</b><span>{html.escape(user)} · {unread} unread</span></header>
    <main><h1>{html.escape(title)}</h1>{body}</main></body></html>''')


@app.get('/', response_class=HTMLResponse)
def projects() -> HTMLResponse:
    db = connect()
    if 'n_plus_one' in VARIANT:
        rows = []
        for pid, name, owner_id in db.cursor().execute('select id, name, owner_id from projects order by name').fetchall():
            owner = db.cursor().execute('select name from users where id = ?', (owner_id,)).fetchone()[0]
            open_count = db.cursor().execute('select count(*) from todos where project_id = ? and done = 0', (pid,)).fetchone()[0]
            rows.append((pid, name, owner, open_count))
    else:
        rows = db.cursor().execute('''select p.id, p.name, u.name, count(t.id) from projects p join users u on u.id = p.owner_id
                             left join todos t on t.project_id = p.id and t.done = 0 group by p.id order by p.name''').fetchall()
    if 'sort_by_open' in VARIANT:
        rows = sorted(rows, key=lambda row: -row[3])
    body = '<table><tr><th>Project</th><th>Owner</th><th>Open tasks</th></tr>' + ''.join(
        f'<tr><td><a href="/projects/{pid}">{html.escape(name)}</a></td><td>{html.escape(owner)}</td><td>{count}</td></tr>'
        for pid, name, owner, count in rows) + '</table>'
    return page('Projects', body, db)


@app.get('/projects/{pid}', response_class=HTMLResponse)
def project(pid: int) -> HTMLResponse:
    db = connect()
    name = db.cursor().execute('select name from projects where id = ?', (pid,)).fetchone()[0]
    todos = db.cursor().execute('select id, title, done from todos where project_id = ? order by id', (pid,)).fetchall()
    left = len(todos) if 'count_bug' in VARIANT else sum(1 for *_, done in todos if not done)
    items = ''.join(
        f'<li><form method="post" action="/todos/{tid}/toggle" style="display:inline">'
        f'<button aria-label="Toggle {html.escape(title)}">{"☑" if done else "☐"}</button></form> '
        f'<span class="{"done" if done else ""}">{html.escape(title)}</span></li>' for tid, title, done in todos)
    body = (f'<form method="post" action="/projects/{pid}/todos"><input type="text" name="title" placeholder="What needs doing?" '
            f'aria-label="New todo"> <button>Add</button></form><ul>{items}</ul>'
            f'<footer>{left} item{"" if left == 1 else "s"} left · <a href="/">All projects</a></footer>')
    return page(name, body, db)


@app.post('/projects/{pid}/todos')
def add_todo(pid: int, title: str = Form()) -> RedirectResponse:
    db = connect()
    db.cursor().execute('insert into todos (project_id, title) values (?, ?)', (pid, title))
    db.commit()
    return RedirectResponse(f'/projects/{pid}', status_code=303)


@app.post('/todos/{tid}/toggle')
def toggle(tid: int) -> RedirectResponse:
    db = connect()
    db.cursor().execute('update todos set done = 1 - done where id = ?', (tid,))
    db.commit()
    pid = db.cursor().execute('select project_id from todos where id = ?', (tid,)).fetchone()[0]
    if 'webhook' in VARIANT:
        try:
            urllib.request.urlopen(urllib.request.Request(
                'http://127.0.0.1:9/hooks/todo-done', data=json.dumps({'todo': tid}).encode(), method='POST'), timeout=2)
        except OSError as error:
            logfire.error('webhook delivery failed for todo {todo}: {error}', todo=tid, error=str(error))
    return RedirectResponse(f'/projects/{pid}', status_code=303)


if os.environ.get('SEED') == '1':
    seed()
