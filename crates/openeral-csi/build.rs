fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc");
    std::env::set_var("PROTOC", protoc);

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(
            &["proto/csi.proto", "proto/openshell_provider_env.proto"],
            &["proto"],
        )
        .expect("compile csi proto");
}
