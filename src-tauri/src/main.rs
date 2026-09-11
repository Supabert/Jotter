// Keeps the console window from flashing on a release launch.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jotter_lib::run()
}
