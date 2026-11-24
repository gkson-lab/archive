//! press run on a project and it works: detect how to run it, resolve the toolchain,
//! and supervise the process in a real pty.

pub mod detect;
pub mod supervisor;

pub use detect::{detect, Candidate, Detection, Mode};
pub use supervisor::{RunInfo, RunOutput, StartSpec, Supervisor};
