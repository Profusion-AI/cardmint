{
  "targets": [
    {
      "target_name": "sony_camera_binding",
      "sources": [
        "sony-camera-production.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/app",
        "/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/app/CRSDK"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags": ["-std=c++17", "-fPIC"],
      "cflags_cc": ["-std=c++17", "-fPIC"],
      "libraries": [
        "-L/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk",
        "-L/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk/CrAdapter",
        "-L/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build",
        "-lCr_Core",
        "-lCr_PTP_USB",
        "-lusb-1.0",
        "-ldl",
        "-Wl,-rpath,/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk",
        "-Wl,-rpath,/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk/CrAdapter",
        "-Wl,-rpath,/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}