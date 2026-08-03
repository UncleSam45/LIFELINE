import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent

def run_engine(expression):
    script = f"const e=require('./journal_sync_engine.js'); console.log(JSON.stringify({expression}));"
    return json.loads(subprocess.check_output(['node', '-e', script], cwd=ROOT, text=True))

def test_normalization_is_deterministic_and_case_insensitive():
    a = run_engine("e.hashJournal({keywords:[' Banana ','BANANA','Fruit'],description:'  hello   world\\r\\nnext  '},'global')")
    b = run_engine("e.hashJournal({keywords:['fruit','banana'],description:'hello world\\nnext'},'global')")
    assert a == b

def test_first_sync_is_non_destructive():
    plan = run_engine("e.buildSynchronizationPlan({scope:'global',initialized:false,locals:[],remotes:[{keywords:['A'],description:'remote'}]})")
    assert plan['counts']['import_remote'] == 1
    assert plan['counts']['delete_remote'] == 0
    assert plan['counts']['delete_local'] == 0

def test_three_way_update_and_delete_rules():
    js = "(()=>{const base=e.hashJournal({keywords:['A'],description:'base'},'personal');const local={keyphrases:['A'],entry:'local',kindroid_sync:{baseline_hash:base,baseline_keywords:['A'],baseline_description:'base'}};return e.buildSynchronizationPlan({scope:'personal',initialized:true,locals:[local],remotes:[{keywords:['A'],description:'base'}]}).operations[0].action})()"
    assert run_engine(js) == 'update_remote'
    js_delete = "(()=>{const base=e.hashJournal({keywords:['A'],description:'base'},'personal');const local={keyphrases:['A'],entry:'base',deleted_at:'now',kindroid_sync:{baseline_hash:base}};return e.buildSynchronizationPlan({scope:'personal',initialized:true,locals:[local],remotes:[{keywords:['A'],description:'base'}]}).operations[0].action})()"
    assert run_engine(js_delete) == 'delete_remote'

def test_competing_changes_conflict():
    js = "(()=>{const base=e.hashJournal({keywords:['A'],description:'base'},'global');const local={journal_keywords:['A'],journal_description:'local',kindroid_sync:{baseline_hash:base}};return e.buildSynchronizationPlan({scope:'global',initialized:true,locals:[local],remotes:[{keywords:['A'],description:'remote'}]}).operations[0].action})()"
    assert run_engine(js) == 'conflict'
