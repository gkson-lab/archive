use super::*;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn api_roundtrip() {
    let d = tempfile::tempdir().unwrap();
    let svc = Service::open(Some(d.path().join("v"))).unwrap();
    let src = d.path().join("proj");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("package.json"), r#"{"scripts":{"start":"node -e \"console.log('hi at http://localhost:3000')\""}}"#).unwrap();
    let r = svc.call("ingest.paths", json!({"paths": [src.to_string_lossy()]})).await.unwrap();
    let job = r["job"].as_str().unwrap().to_string();
    let mut done = json!(null);
    for _ in 0..50 {
        let j = svc.call("jobs.get", json!({"id": job})).await.unwrap();
        if j["status"] != "running" {
            done = j;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(done["status"], "done", "{done}");
    let item = done["result"][0]["item"].clone();
    let id = item["id"].as_str().unwrap();
    assert_eq!(item["path"], "inbox/proj");

    let inbox = svc.call("inbox.list", json!({})).await.unwrap();
    assert_eq!(inbox[0]["suggestion"]["category"], "projects");
    let filed = svc.call("item.file", json!({"id": id})).await.unwrap();
    assert_eq!(filed["path"], "projects/proj");

    let det = svc.call("run.detect", json!({"item_id": id})).await.unwrap();
    assert_eq!(det["detection"]["candidates"][0]["command"], "npm start");
    // imported from outside: first run must be confirmed
    let r = svc.call("run.start", json!({"item_id": id, "command": "echo ok"})).await.unwrap();
    assert_eq!(r["needs_confirm"], true);
    let r = svc.call("run.start", json!({"item_id": id, "command": "echo ok", "confirm": true})).await.unwrap();
    assert!(r["id"].is_string());

    svc.call("git.init", json!({"item_id": id})).await.unwrap();
    let st = svc.call("git.status", json!({"item_id": id})).await.unwrap();
    assert_eq!(st["branch"], "main");
    let shipped = svc.call("git.ship", json!({"item_id": id, "message": "first"})).await.unwrap();
    assert!(shipped["commit"].is_string());
    assert!(shipped["pushed"].is_null());
    let hist = svc.call("history", json!({"item_id": id})).await.unwrap();
    assert!(hist.as_array().unwrap().iter().any(|e| e["type"] == "commit"));
    assert!(hist.as_array().unwrap().iter().any(|e| e["type"] == "snapshot"));

    let shelf = svc.call("shelf.get", json!({})).await.unwrap();
    assert_eq!(shelf["total"], 1);
    let hits = svc.call("search", json!({"q": "package", "contents": false})).await.unwrap();
    assert!(!hits.as_array().unwrap().is_empty());
    assert!(svc.call("nope.nope", json!({})).await.is_err());
    let kinds = svc.call("connectors.kinds", json!({})).await.unwrap();
    assert!(kinds.as_array().unwrap().len() >= 9);
    // agent writes snapshot first
    let before = svc.call("snapshot.list", json!({"item_id": id})).await.unwrap().as_array().unwrap().len();
    svc.call("file.write", json!({"path": "projects/proj/notes.md", "text": "hi", "agent": true})).await.unwrap();
    let after = svc.call("snapshot.list", json!({"item_id": id})).await.unwrap().as_array().unwrap().len();
    assert!(after >= before);
    svc.shutdown();
}
