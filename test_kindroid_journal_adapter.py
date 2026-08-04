import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).parent


def test_index_and_open_click_only_confirmed_journal_rows():
    script = r"""
const { KindroidJournalAdapter } = require('./kindroid_journal_adapter.cjs');
const clicks = { global:0, personal:0, plus:0, back:0, settings:0, navigation:0, first:0, second:0 };
const container = { scrollTop:0, scrollHeight:100, clientHeight:100, parentElement:null };
function control(name) {
  return { textContent:name, innerText:name, children:[], dataset:{}, getClientRects:()=>[{}], click:()=>{clicks[name.toLowerCase()] += 1;} };
}
function row(name, title, description, id) {
  const titleNode = { textContent:title };
  const descriptionNode = { textContent:description };
  return {
    textContent:`${title} ${description}`, innerText:`${title} ${description}`, children:[], dataset:{ journalId:id },
    getClientRects:()=>[{}],
    querySelector:(selector)=>selector.includes('entry-title') ? titleNode : selector.includes('entry-description') ? descriptionNode : null,
    parentElement:container, closest:()=>container,
    scrollIntoView:()=>{},
    click:()=>{clicks[name] += 1;},
  };
}
const controls = [control('global'), control('personal'), control('plus'), control('back'), control('settings'), control('navigation')];
const rows = [row('first','Alpha','First description','one'), row('second','Beta','Second description','two')];
global.document = {
  scrollingElement:container,
  querySelectorAll:(selector)=>selector === 'button[class*="journal-sheet-v2_entry-row"]' ? rows : selector === 'button' ? [...controls,...rows] : [],
};
const window = { isDestroyed:()=>false, webContents:{ executeJavaScript:async source=>eval(source) } };
(async()=>{
  const adapter = new KindroidJournalAdapter(window);
  adapter.waitFor = async()=>({ready:true});
  const index = await adapter.scanJournalIndex();
  await adapter.openJournalEntry(index[1].handle);
  console.log(JSON.stringify({ index, clicks }));
})().catch(error=>{ console.error(error); process.exit(1); });
"""
    result = json.loads(subprocess.check_output(["node", "-e", script], cwd=ROOT, text=True))
    assert [entry["title"] for entry in result["index"]] == ["Alpha", "Beta"]
    assert result["clicks"]["second"] == 1
    assert result["clicks"]["first"] == 0
    assert all(result["clicks"][name] == 0 for name in ("global", "personal", "plus", "back", "settings", "navigation"))


def test_adapter_never_uses_browser_history_for_recovery():
    source = (ROOT / "kindroid_journal_adapter.cjs").read_text(encoding="utf-8")
    recovery = source.split("async returnToJournalList", 1)[1].split("async scan(scope)", 1)[0]
    assert "history.back" not in recovery
    assert "button[aria-label=\"Back\"]" in recovery


def test_read_path_has_no_generic_row_selector_fallback():
    source = (ROOT / "kindroid_journal_adapter.cjs").read_text(encoding="utf-8")
    indexer = source.split("async scanJournalIndex", 1)[1].split("async openJournalEntry", 1)[0]
    opener = source.split("async openJournalEntry", 1)[1].split("async readJournalEditor", 1)[0]
    for section in (indexer, opener):
        assert "[role=\"listitem\"]" not in section
        assert "[data-journal-id]" not in section
        assert "button[class*=\"journal-sheet-v2_entry-row\"]" in section
