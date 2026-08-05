{
  description = "Verification toolchain for mizchi/converge_audit";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.2405";
  # Quint was added after the MoonBit/Why3 toolchain pin above. Keep the
  # existing verifier environment stable and source Quint from its own pin.
  inputs.nixpkgs-quint.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, nixpkgs-quint, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f nixpkgs.legacyPackages.${system} nixpkgs-quint.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: quintPkgs: {
        default = pkgs.mkShell {
          packages = [
            quintPkgs.quint
            pkgs.why3
            pkgs.z3
          ];
          WHY3DATA = "${pkgs.why3}/share/why3";
          WHY3LIB = "${pkgs.why3}/lib/why3";
          Z3PATH = "${pkgs.z3}/bin/z3";
        };
      });
    };
}
