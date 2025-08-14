#include <napi.h>
#include <thread>
#include <chrono>
#include <vector>
#include <cstring>
#include <iostream>
#include <filesystem>
#include <mutex>
#include <dlfcn.h>
#include "CRSDK/CameraRemote_SDK.h"
#include "CRSDK/IDeviceCallback.h"

namespace SDK = SCRSDK;
namespace fs = std::filesystem;
using namespace std::chrono_literals;

// Global SDK state management
static std::mutex g_sdk_mutex;
static bool g_sdk_initialized = false;
static fs::path g_original_path;
static fs::path g_sdk_path = "/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build";

// Helper to run code in SDK directory context
template<typename Func>
auto runInSdkContext(Func&& func) -> decltype(func()) {
    std::lock_guard<std::mutex> lock(g_sdk_mutex);
    
    auto current_path = fs::current_path();
    fs::current_path(g_sdk_path);
    
    try {
        auto result = func();
        fs::current_path(current_path);
        return result;
    } catch (...) {
        fs::current_path(current_path);
        throw;
    }
}

// Initialize SDK once, globally
bool initializeSdkOnce() {
    std::lock_guard<std::mutex> lock(g_sdk_mutex);
    
    if (g_sdk_initialized) {
        return true;
    }
    
    g_original_path = fs::current_path();
    fs::current_path(g_sdk_path);
    
    std::cout << "[SDK] Initializing from: " << fs::current_path() << std::endl;
    
    // Pre-load all required adapter libraries with RTLD_GLOBAL
    void* core_handle = dlopen("./libCr_Core.so", RTLD_NOW | RTLD_GLOBAL);
    if (!core_handle) {
        std::cerr << "[SDK] Failed to load Core: " << dlerror() << std::endl;
        fs::current_path(g_original_path);
        return false;
    }
    
    void* usb_handle = dlopen("./CrAdapter/libCr_PTP_USB.so", RTLD_NOW | RTLD_GLOBAL);
    if (!usb_handle) {
        std::cerr << "[SDK] Failed to load USB adapter: " << dlerror() << std::endl;
        fs::current_path(g_original_path);
        return false;
    }
    
    void* libusb_handle = dlopen("./CrAdapter/libusb-1.0.so", RTLD_NOW | RTLD_GLOBAL);
    if (!libusb_handle) {
        std::cerr << "[SDK] Failed to load libusb: " << dlerror() << std::endl;
        fs::current_path(g_original_path);
        return false;
    }
    
    std::cout << "[SDK] All libraries loaded, initializing SDK..." << std::endl;
    
    auto init_success = SDK::Init();
    if (!init_success) {
        std::cerr << "[SDK] Failed to initialize" << std::endl;
        fs::current_path(g_original_path);
        return false;
    }
    
    std::cout << "[SDK] Successfully initialized" << std::endl;
    g_sdk_initialized = true;
    
    // Keep SDK directory as working directory - DO NOT restore
    // The SDK needs to stay in its directory to work properly
    return true;
}

class ProductionCamera : public SDK::IDeviceCallback {
private:
    SDK::ICrCameraObjectInfo* m_info = nullptr;
    CrInt64 m_handle = 0;
    bool m_connected = false;
    std::string m_last_image_path;
    
public:
    ProductionCamera() {
        if (!g_sdk_initialized) {
            if (!initializeSdkOnce()) {
                throw std::runtime_error("Failed to initialize Sony SDK");
            }
        }
    }
    
    ~ProductionCamera() {
        if (m_connected) {
            disconnect();
        }
    }
    
    std::vector<std::pair<std::string, std::string>> listDevices() {
        return runInSdkContext([this]() {
            std::vector<std::pair<std::string, std::string>> devices;
            
            std::cout << "[ListDevices] Current directory: " << fs::current_path() << std::endl;
            
            SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
            auto result = SDK::EnumCameraObjects(&camera_list);
            
            std::cout << "[ListDevices] EnumCameraObjects returned: 0x" << std::hex << result << std::dec << std::endl;
            
            if (CR_SUCCEEDED(result) && camera_list) {
                auto count = camera_list->GetCount();
                std::cout << "[ListDevices] Found " << count << " camera(s)" << std::endl;
                
                for (CrInt32u i = 0; i < count; ++i) {
                    auto cam_info = camera_list->GetCameraObjectInfo(i);
                    if (cam_info) {
                        CrChar* model = cam_info->GetModel();
                        CrInt8u* id = cam_info->GetId();
                        
                        devices.push_back({
                            model ? std::string((char*)model) : "Unknown",
                            id ? std::string((char*)id) : ""
                        });
                    }
                }
                camera_list->Release();
            } else {
                std::cout << "[ListDevices] Failed to enumerate or no cameras" << std::endl;
            }
            
            return devices;
        });
    }
    
    bool connect() {
        return runInSdkContext([this]() {
            if (m_connected) {
                return true;
            }
            
            SDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
            auto result = SDK::EnumCameraObjects(&camera_list);
            
            if (CR_FAILED(result) || !camera_list) {
                return false;
            }
            
            auto count = camera_list->GetCount();
            if (count == 0) {
                camera_list->Release();
                return false;
            }
            
            auto cam_info = camera_list->GetCameraObjectInfo(0);
            m_info = const_cast<SDK::ICrCameraObjectInfo*>(cam_info);
            camera_list->Release();
            
            if (!m_info) {
                return false;
            }
            
            result = SDK::Connect(
                m_info,
                this,
                &m_handle,
                SDK::CrSdkControlMode_Remote,
                SDK::CrReconnecting_ON
            );
            
            if (CR_SUCCEEDED(result)) {
                m_connected = true;
                std::cout << "[Camera] Connected successfully" << std::endl;
                return true;
            }
            
            return false;
        });
    }
    
    bool disconnect() {
        return runInSdkContext([this]() {
            if (m_connected && m_handle) {
                SDK::Disconnect(m_handle);
                SDK::ReleaseDevice(m_handle);
                m_handle = 0;
                m_connected = false;
                std::cout << "[Camera] Disconnected" << std::endl;
                return true;
            }
            return false;
        });
    }
    
    bool capture() {
        return runInSdkContext([this]() {
            if (!m_connected || !m_handle) {
                return false;
            }
            
            // Shutter down
            SDK::SendCommand(m_handle, SDK::CrCommandId::CrCommandId_Release, SDK::CrCommandParam_Down);
            std::this_thread::sleep_for(35ms);
            
            // Shutter up
            SDK::SendCommand(m_handle, SDK::CrCommandId::CrCommandId_Release, SDK::CrCommandParam_Up);
            
            // Generate timestamp-based filename
            auto now = std::chrono::system_clock::now();
            auto time_t = std::chrono::system_clock::to_time_t(now);
            m_last_image_path = "/tmp/sony_capture_" + std::to_string(time_t) + ".jpg";
            
            std::cout << "[Camera] Capture triggered" << std::endl;
            return true;
        });
    }
    
    std::string getLastImagePath() const {
        return m_last_image_path;
    }
    
    std::string getModelName() {
        return runInSdkContext([this]() {
            if (m_info) {
                CrChar* model = m_info->GetModel();
                if (model) {
                    return std::string((char*)model);
                }
            }
            return std::string("No camera");
        });
    }
    
    bool isConnected() const { 
        return m_connected; 
    }
    
    // IDeviceCallback implementation - no overrides needed
    void OnConnected(SDK::ICrCameraObjectInfo* pCameraObjectInfo) {
        std::cout << "[Callback] Camera connected" << std::endl;
    }
    
    void OnDisconnected(CrInt32u error) {
        std::cout << "[Callback] Camera disconnected: 0x" << std::hex << error << std::endl;
        m_connected = false;
    }
    
    void OnPropertyChanged() {}
    void OnLvPropertyChanged() {}
    void OnError(CrInt32u error) {
        std::cout << "[Callback] Error: 0x" << std::hex << error << std::endl;
    }
    void OnWarning(CrInt32u warning) {
        std::cout << "[Callback] Warning: 0x" << std::hex << warning << std::endl;
    }
};

// Node.js wrapper
class ProductionCameraWrapper : public Napi::ObjectWrap<ProductionCameraWrapper> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "SonyCamera", {
            InstanceMethod("connect", &ProductionCameraWrapper::Connect),
            InstanceMethod("disconnect", &ProductionCameraWrapper::Disconnect),
            InstanceMethod("captureImage", &ProductionCameraWrapper::CaptureImage),
            InstanceMethod("getDeviceInfo", &ProductionCameraWrapper::GetDeviceInfo),
            InstanceMethod("listDevices", &ProductionCameraWrapper::ListDevices),
        });
        
        constructor = Napi::Persistent(func);
        constructor.SuppressDestruct();
        
        exports.Set("SonyCamera", func);
        return exports;
    }
    
    ProductionCameraWrapper(const Napi::CallbackInfo& info) 
        : Napi::ObjectWrap<ProductionCameraWrapper>(info) {
        try {
            m_camera = std::make_unique<ProductionCamera>();
        } catch (const std::exception& e) {
            Napi::Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
        }
    }
    
private:
    static Napi::FunctionReference constructor;
    std::unique_ptr<ProductionCamera> m_camera;
    
    Napi::Value Connect(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        bool result = m_camera->connect();
        return Napi::Boolean::New(env, result);
    }
    
    Napi::Value Disconnect(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        bool result = m_camera->disconnect();
        return Napi::Boolean::New(env, result);
    }
    
    Napi::Value CaptureImage(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        if (!m_camera->isConnected()) {
            Napi::Error::New(env, "Camera not connected").ThrowAsJavaScriptException();
            return env.Null();
        }
        
        Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
        
        bool result = m_camera->capture();
        
        if (result) {
            deferred.Resolve(Napi::String::New(env, m_camera->getLastImagePath()));
        } else {
            deferred.Reject(Napi::Error::New(env, "Capture failed").Value());
        }
        
        return deferred.Promise();
    }
    
    Napi::Value GetDeviceInfo(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::Object result = Napi::Object::New(env);
        
        result.Set("model", Napi::String::New(env, m_camera->getModelName()));
        result.Set("connected", Napi::Boolean::New(env, m_camera->isConnected()));
        
        return result;
    }
    
    Napi::Value ListDevices(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        Napi::Array devices = Napi::Array::New(env);
        
        auto device_list = m_camera->listDevices();
        
        for (size_t i = 0; i < device_list.size(); ++i) {
            Napi::Object device = Napi::Object::New(env);
            device.Set("model", Napi::String::New(env, device_list[i].first));
            device.Set("id", Napi::String::New(env, device_list[i].second));
            device.Set("index", Napi::Number::New(env, i));
            devices.Set(i, device);
        }
        
        return devices;
    }
};

Napi::FunctionReference ProductionCameraWrapper::constructor;

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    return ProductionCameraWrapper::Init(env, exports);
}

NODE_API_MODULE(sony_camera_binding, InitAll)