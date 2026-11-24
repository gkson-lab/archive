//! content-addressed blob store: blake3 hash, zstd compressed, sharded by the first two hex chars.

use crate::Result;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct ObjectStore {
    root: PathBuf,
}

impl ObjectStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path_for(&self, hash: &str) -> PathBuf {
        self.root.join(&hash[..2]).join(&hash[2..])
    }

    pub fn has(&self, hash: &str) -> bool {
        hash.len() > 2 && self.path_for(hash).exists()
    }

    pub fn hash_file(path: &Path) -> Result<String> {
        let mut hasher = blake3::Hasher::new();
        let mut f = fs::File::open(path)?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize().to_hex().to_string())
    }

    pub fn put_bytes(&self, data: &[u8]) -> Result<String> {
        let hash = blake3::hash(data).to_hex().to_string();
        if !self.has(&hash) {
            let p = self.path_for(&hash);
            fs::create_dir_all(p.parent().unwrap())?;
            let tmp = p.with_extension("tmp");
            let compressed = zstd::encode_all(data, 3)?;
            fs::File::create(&tmp)?.write_all(&compressed)?;
            fs::rename(&tmp, &p)?;
        }
        Ok(hash)
    }

    /// store a file, returning its hash. files already present are not rewritten (dedup).
    pub fn put_file(&self, path: &Path) -> Result<String> {
        let hash = Self::hash_file(path)?;
        if !self.has(&hash) {
            let p = self.path_for(&hash);
            fs::create_dir_all(p.parent().unwrap())?;
            let tmp = p.with_extension("tmp");
            {
                let input = fs::File::open(path)?;
                let out = fs::File::create(&tmp)?;
                zstd::stream::copy_encode(input, out, 3)?;
            }
            fs::rename(&tmp, &p)?;
        }
        Ok(hash)
    }

    pub fn get(&self, hash: &str) -> Result<Vec<u8>> {
        let f = fs::File::open(self.path_for(hash))?;
        Ok(zstd::decode_all(f)?)
    }

    pub fn write_to(&self, hash: &str, dest: &Path) -> Result<()> {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let input = fs::File::open(self.path_for(hash))?;
        let out = fs::File::create(dest)?;
        zstd::stream::copy_decode(input, out)?;
        Ok(())
    }

    /// bytes on disk used by the store
    pub fn disk_usage(&self) -> u64 {
        walkdir::WalkDir::new(&self.root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_dedup() {
        let d = tempfile::tempdir().unwrap();
        let s = ObjectStore::new(d.path().join("o"));
        let h1 = s.put_bytes(b"hello").unwrap();
        let h2 = s.put_bytes(b"hello").unwrap();
        assert_eq!(h1, h2);
        assert_eq!(s.get(&h1).unwrap(), b"hello");
        let f = d.path().join("f.txt");
        std::fs::write(&f, b"hello").unwrap();
        assert_eq!(s.put_file(&f).unwrap(), h1);
    }
}
