//! soft delete. trashed paths move to `.archival/trash/<id>/<name>` and can be restored
//! until the retention window passes.

pub const DEFAULT_RETENTION_DAYS: i64 = 30;

pub fn day_ms() -> i64 {
    24 * 60 * 60 * 1000
}
