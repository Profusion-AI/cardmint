#include <iostream>
#include <vector>
#include "CRSDK/CameraRemote_SDK.h"

int main() {
    std::cout << "Testing Sony SDK directly..." << std::endl;
    
    // Initialize SDK
    auto init_success = SCRSDK::Init();
    if (!init_success) {
        std::cout << "Failed to initialize SDK" << std::endl;
        return 1;
    }
    
    std::cout << "SDK initialized successfully" << std::endl;
    
    // Enumerate cameras
    SCRSDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
    auto enum_result = SCRSDK::EnumCameraObjects(&camera_list);
    
    if (CR_FAILED(enum_result)) {
        std::cout << "Failed to enumerate cameras: 0x" << std::hex << enum_result << std::endl;
        SCRSDK::Release();
        return 1;
    }
    
    if (!camera_list) {
        std::cout << "Camera list is null" << std::endl;
        SCRSDK::Release();
        return 1;
    }
    
    auto count = camera_list->GetCount();
    std::cout << "Found " << count << " camera(s)" << std::endl;
    
    for (CrInt32u i = 0; i < count; ++i) {
        auto cam_info = camera_list->GetCameraObjectInfo(i);
        if (cam_info) {
            CrChar* model = cam_info->GetModel();
            CrInt8u* id = cam_info->GetId();
            
            std::cout << "[" << i << "] " << (model ? (char*)model : "Unknown") 
                      << " (" << (id ? (char*)id : "") << ")" << std::endl;
        }
    }
    
    camera_list->Release();
    SCRSDK::Release();
    
    std::cout << "Test complete" << std::endl;
    return 0;
}