// Checks a signature written by `tauri signer sign` exactly the way the updater plugin does (minisign over the file, then
// the version in the trusted comment): `verify_sig <pubkey> <file> <file.sig> <version>`. Used by
// tools/ci/test-publish-update.sh to prove that what tools/publish-update.mjs signs is accepted by the app's side.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn decode(s: &str) -> String {
    let bytes = base64::engine::general_purpose::STANDARD.decode(s.trim()).expect("base64");
    String::from_utf8(bytes).expect("utf8")
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 5 {
        eprintln!("usage: verify_sig <pubkey> <file> <file.sig> <version>");
        std::process::exit(2);
    }
    let pk = PublicKey::decode(&decode(&a[1])).expect("public key");
    let sig_text = std::fs::read_to_string(&a[3]).expect("sig file");
    let sig = Signature::decode(&decode(&sig_text)).expect("signature");
    let data = std::fs::read(&a[2]).expect("file");
    if pk.verify(&data, &sig, true).is_err() {
        eprintln!("signature does not verify");
        std::process::exit(1);
    }
    let want = format!("version:{}", a[4]);
    if !sig.trusted_comment().split('\t').any(|f| f == want) {
        eprintln!("trusted comment has no {want}: {}", sig.trusted_comment());
        std::process::exit(1);
    }
    println!("OK {}", sig.trusted_comment());
}
