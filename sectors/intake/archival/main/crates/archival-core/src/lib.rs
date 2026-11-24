//! archival-core: the vault on disk, its sqlite index, the content-addressed object store,
//! snapshots, trash and search. every front end (desktop, cli, mcp) goes through this crate.

pub mod classify;
pub mod error;
pub mod index;
pub mod objects;
pub mod paths;
pub mod search;
pub mod snapshot;
pub mod trash;
pub mod tree;
pub mod types;
pub mod vault;

pub use error::{Error, Result};
pub use types::*;
pub use vault::Vault;
