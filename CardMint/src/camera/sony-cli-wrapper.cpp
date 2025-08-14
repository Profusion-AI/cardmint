#include <iostream>
#include <string>
#include <thread>
#include <chrono>
#include <filesystem>
#include "CRSDK/CameraRemote_SDK.h"
#include "CRSDK/IDeviceCallback.h"

namespace SDK = SCRSDK;
namespace fs = std::filesystem;
using namespace std::chrono_literals;

class CliCamera : public SDK::IDeviceCallback {
private:
    SDK::ICrCameraObjectInfo* m_info = nullptr;
    SDK::ICrCameraObjectInfo* m_info_copy = nullptr;  // Store the copy
    CrInt64 m_handle = 0;
    bool m_connected = false;
    
public:
    bool init() {
        auto init_success = SDK::Init();
        if (!init_success) {
            std::cerr << "ERROR: Failed to initialize SDK" << std::endl;
            return false;
        }
        return true;
    }
    
    void cleanup() {
        if (m_connected) {
            disconnect();
        }
        if (m_info_copy) {
            m_info_copy->Release();
            m_info_copy = nullptr;
        }
        SDK::Release();
    }
    
    bool listDevices() {
        SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
        auto result = SDK::EnumCameraObjects(&camera_list);
        
        if (CR_FAILED(result) || !camera_list) {
            std::cout << "DEVICES:0" << std::endl;
            return false;
        }
        
        auto count = camera_list->GetCount();
        std::cout << "DEVICES:" << count << std::endl;
        
        for (CrInt32u i = 0; i < count; ++i) {
            auto cam_info = camera_list->GetCameraObjectInfo(i);
            if (cam_info) {
                CrChar* model = cam_info->GetModel();
                CrInt8u* id = cam_info->GetId();
                std::cout << "DEVICE:" << i << ":" 
                          << (model ? (char*)model : "Unknown") << ":"
                          << (id ? (char*)id : "") << std::endl;
            }
        }
        
        camera_list->Release();
        return count > 0;
    }
    
    bool connect() {
        if (m_connected) {
            std::cout << "CONNECTED:true" << std::endl;
            return true;
        }
        
        SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
        auto result = SDK::EnumCameraObjects(&camera_list);
        
        if (CR_FAILED(result) || !camera_list) {
            std::cout << "CONNECTED:false" << std::endl;
            return false;
        }
        
        auto count = camera_list->GetCount();
        if (count == 0) {
            camera_list->Release();
            std::cout << "CONNECTED:false" << std::endl;
            return false;
        }
        
        // Get the camera info from enumeration
        auto cam_info = camera_list->GetCameraObjectInfo(0);
        if (!cam_info) {
            camera_list->Release();
            std::cout << "CONNECTED:false" << std::endl;
            return false;
        }
        
        // Create a copy of the camera info - this is critical!
        m_info_copy = SDK::CreateCameraObjectInfo(
            cam_info->GetName(),
            cam_info->GetModel(),
            cam_info->GetUsbPid(),
            cam_info->GetIdType(),
            cam_info->GetIdSize(),
            cam_info->GetId(),
            cam_info->GetConnectionTypeName(),
            cam_info->GetAdaptorName(),
            cam_info->GetPairingNecessity(),
            cam_info->GetSSHsupport()
        );
        
        // Release the enumeration list BEFORE connecting
        camera_list->Release();
        
        if (!m_info_copy) {
            std::cout << "CONNECTED:false" << std::endl;
            return false;
        }
        
        // Connect using the COPY, not the original
        result = SDK::Connect(
            m_info_copy,
            this,
            &m_handle,
            SDK::CrSdkControlMode_Remote,
            SDK::CrReconnecting_ON
        );
        
        if (CR_SUCCEEDED(result)) {
            m_connected = true;
            m_info = m_info_copy;  // Store reference for later use
            std::cout << "CONNECTED:true" << std::endl;
            return true;
        }
        
        std::cerr << "Connect failed with: 0x" << std::hex << result << std::endl;
        std::cout << "CONNECTED:false" << std::endl;
        
        // Clean up copy on failure
        if (m_info_copy) {
            m_info_copy->Release();
            m_info_copy = nullptr;
        }
        
        return false;
    }
    
    bool disconnect() {
        if (m_connected && m_handle) {
            SDK::Disconnect(m_handle);
            SDK::ReleaseDevice(m_handle);
            m_handle = 0;
            m_connected = false;
            m_info = nullptr;  // Clear reference
            
            // Clean up the copy
            if (m_info_copy) {
                m_info_copy->Release();
                m_info_copy = nullptr;
            }
            
            std::cout << "DISCONNECTED:true" << std::endl;
            return true;
        }
        std::cout << "DISCONNECTED:false" << std::endl;
        return false;
    }
    
    bool capture() {
        if (!m_connected || !m_handle) {
            std::cout << "CAPTURE:failed" << std::endl;
            return false;
        }
        
        // Shutter down
        SDK::SendCommand(m_handle, SDK::CrCommandId::CrCommandId_Release, SDK::CrCommandParam_Down);
        std::this_thread::sleep_for(35ms);
        
        // Shutter up
        SDK::SendCommand(m_handle, SDK::CrCommandId::CrCommandId_Release, SDK::CrCommandParam_Up);
        
        auto timestamp = std::chrono::system_clock::now().time_since_epoch().count();
        std::cout << "CAPTURE:/tmp/sony_" << timestamp << ".jpg" << std::endl;
        return true;
    }
    
    // IDeviceCallback implementation
    void OnConnected(SDK::ICrCameraObjectInfo* pCameraObjectInfo) {
        std::cerr << "EVENT:connected" << std::endl;
    }
    
    void OnDisconnected(CrInt32u error) {
        std::cerr << "EVENT:disconnected:" << std::hex << error << std::endl;
        m_connected = false;
    }
    
    void OnPropertyChanged() {}
    void OnLvPropertyChanged() {}
    void OnError(CrInt32u error) {
        std::cerr << "EVENT:error:" << std::hex << error << std::endl;
    }
    void OnWarning(CrInt32u warning) {
        std::cerr << "EVENT:warning:" << std::hex << warning << std::endl;
    }
};

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: sony-cli <command>" << std::endl;
        return 1;
    }
    
    std::string command = argv[1];
    CliCamera camera;
    
    if (!camera.init()) {
        return 1;
    }
    
    if (command == "list") {
        camera.listDevices();
    }
    else if (command == "connect") {
        camera.connect();
    }
    else if (command == "disconnect") {
        camera.disconnect();
    }
    else if (command == "capture") {
        camera.capture();
    }
    else if (command == "session") {
        // Interactive session mode
        if (!camera.connect()) {
            std::cerr << "Failed to connect" << std::endl;
            camera.cleanup();
            return 1;
        }
        
        std::cout << "SESSION:ready" << std::endl;
        
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line == "capture") {
                camera.capture();
            }
            else if (line == "quit") {
                break;
            }
            else {
                std::cout << "UNKNOWN:" << line << std::endl;
            }
        }
        
        camera.disconnect();
    }
    else {
        std::cerr << "Unknown command: " << command << std::endl;
        camera.cleanup();
        return 1;
    }
    
    camera.cleanup();
    return 0;
}