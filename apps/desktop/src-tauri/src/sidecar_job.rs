//! Ties the sidecar's lifetime to the host process. The Tauri updater ends
//! the app with `std::process::exit` to let the installer run, which skips
//! every Drop, and a crash skips them too; the orphaned sidecar then keeps
//! `sidecar.exe` locked and the installer fails on it. A job object with
//! kill-on-close makes Windows end the sidecar the moment the last handle
//! to the job goes away, which is when this process goes away for any
//! reason.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

pub struct SidecarJob(HANDLE);

// The handle is only ever handed to the job object APIs, which take it
// from any thread.
unsafe impl Send for SidecarJob {}
unsafe impl Sync for SidecarJob {}

impl SidecarJob {
    pub fn new() -> windows::core::Result<Self> {
        // SAFETY: plain Win32 calls with valid arguments; the job handle is
        // closed in Drop and the limit struct outlives the call that reads it.
        unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null())?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if let Err(e) = set {
                let _ = CloseHandle(job);
                return Err(e);
            }
            Ok(Self(job))
        }
    }

    pub fn assign(&self, pid: u32) -> windows::core::Result<()> {
        // SAFETY: the process handle is opened and closed here; the job
        // handle is live for as long as `self` is.
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)?;
            let assigned = AssignProcessToJobObject(self.0, process);
            let _ = CloseHandle(process);
            assigned
        }
    }
}

impl Drop for SidecarJob {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateJobObjectW and is closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn closing_the_job_ends_the_process() {
        let job = SidecarJob::new().unwrap();
        let mut child = Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        job.assign(child.id()).unwrap();
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "child outlived the job");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn assign_rejects_a_pid_that_does_not_exist() {
        let job = SidecarJob::new().unwrap();
        assert!(job.assign(u32::MAX - 1).is_err());
    }
}
