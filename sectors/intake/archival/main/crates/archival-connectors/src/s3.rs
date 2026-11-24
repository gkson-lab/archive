use crate::util::{register_folder, write};
use crate::{AuthState, Connector, Page, PushResult, RemoteEntry};
use anyhow::{anyhow, Result};
use archival_core::{Item, Vault};
use archival_ingest::{new_inbox_folder, Ingested, Origin};
use async_trait::async_trait;
use futures::TryStreamExt;
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use std::sync::Arc;

pub struct Bucket {
    store: AmazonS3,
    bucket: String,
    prefix: String,
}

impl Bucket {
    pub fn new(bucket: String, region: Option<String>, endpoint: Option<String>, prefix: String, key: String, secret: String) -> Result<Self> {
        let mut b = AmazonS3Builder::new()
            .with_bucket_name(&bucket)
            .with_region(region.unwrap_or_else(|| "us-east-1".into()))
            .with_access_key_id(key)
            .with_secret_access_key(secret);
        if let Some(e) = endpoint {
            b = b.with_allow_http(e.starts_with("http://")).with_endpoint(e).with_virtual_hosted_style_request(false);
        }
        Ok(Self { store: b.build().map_err(|e| anyhow!("bucket settings: {e}"))?, bucket, prefix: prefix.trim_matches('/').to_string() })
    }

    fn base(&self, folder: Option<String>) -> Option<ObjPath> {
        let p = folder.unwrap_or_else(|| self.prefix.clone());
        if p.is_empty() {
            None
        } else {
            Some(ObjPath::from(p.as_str()))
        }
    }
}

#[async_trait]
impl Connector for Bucket {
    fn id(&self) -> &str {
        "s3"
    }
    async fn auth(&self) -> Result<AuthState> {
        self.store.list_with_delimiter(self.base(None).as_ref()).await.map_err(|e| anyhow!("can't list the bucket: {e}"))?;
        Ok(AuthState { ok: true, who: Some(self.bucket.clone()) })
    }
    async fn list(&self, folder: Option<String>, _page: Option<String>) -> Result<Page> {
        let r = self.store.list_with_delimiter(self.base(folder).as_ref()).await.map_err(|e| anyhow!("{e}"))?;
        let mut entries: Vec<RemoteEntry> = r
            .common_prefixes
            .into_iter()
            .map(|p| RemoteEntry {
                name: p.filename().unwrap_or(p.as_ref()).to_string(),
                id: p.to_string(),
                kind: "dir".into(),
                size: None,
                updated: None,
                description: None,
                browsable: true,
            })
            .collect();
        entries.extend(r.objects.into_iter().map(|o| RemoteEntry {
            name: o.location.filename().unwrap_or(o.location.as_ref()).to_string(),
            id: o.location.to_string(),
            kind: "file".into(),
            size: Some(o.size as u64),
            updated: Some(o.last_modified.to_rfc3339()),
            description: None,
            browsable: false,
        }));
        Ok(Page { entries, next: None })
    }
    async fn pull(&self, v: Arc<Vault>, entry: &RemoteEntry) -> Result<Ingested> {
        let dir = new_inbox_folder(&v, &entry.name)?;
        if entry.browsable {
            let prefix = ObjPath::from(entry.id.as_str());
            let objs: Vec<_> = self.store.list(Some(&prefix)).try_collect().await.map_err(|e| anyhow!("{e}"))?;
            for o in objs.into_iter().take(2000) {
                let rel = o.location.as_ref().strip_prefix(prefix.as_ref()).unwrap_or(o.location.as_ref()).trim_start_matches('/');
                let bytes = self.store.get(&o.location).await.map_err(|e| anyhow!("{e}"))?.bytes().await.map_err(|e| anyhow!("{e}"))?;
                let dest = archival_core::paths::resolve(&dir, rel)?;
                write(&dest, &bytes)?;
            }
        } else {
            let bytes = self.store.get(&ObjPath::from(entry.id.as_str())).await.map_err(|e| anyhow!("{e}"))?.bytes().await.map_err(|e| anyhow!("{e}"))?;
            write(&dir.join(archival_core::paths::safe_name(&entry.name)), &bytes)?;
        }
        register_folder(v, dir, Origin { connector: "s3".into(), source: format!("s3://{}/{}", self.bucket, entry.id), title: Some(entry.name.clone()) }).await
    }
    async fn push(&self, v: Arc<Vault>, item: &Item, target: Option<String>) -> Result<PushResult> {
        if item.local_only {
            return Err(anyhow!("this item is marked local only"));
        }
        let abs = v.abs(&item.path)?;
        let name = item.path.rsplit('/').next().unwrap_or("item").to_string();
        let base = target.unwrap_or_else(|| if self.prefix.is_empty() { name.clone() } else { format!("{}/{name}", self.prefix) });
        let root = if abs.is_file() { abs.parent().unwrap().to_path_buf() } else { abs.clone() };
        let mut n = 0;
        for f in archival_core::tree::walk_files(&abs) {
            let rel = archival_core::paths::relative(&root, &f);
            let key = if abs.is_file() { format!("{base}") } else { format!("{base}/{rel}") };
            let bytes = std::fs::read(&f)?;
            self.store.put(&ObjPath::from(key.as_str()), PutPayload::from(bytes)).await.map_err(|e| anyhow!("upload failed: {e}"))?;
            n += 1;
        }
        Ok(PushResult { location: format!("s3://{}/{base}", self.bucket), files: n })
    }
}
