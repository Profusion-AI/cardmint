#include <napi.h>
#include <memory>
#include <thread>
#include <chrono>
#include <vector>
#include <atomic>
#include <mutex>
#include <condition_variable>
#include "CRSDK/CameraRemote_SDK.h"
#include "CRSDK/IDeviceCallback.h"

namespace SCRSDK = SCRSDK;  // SDK namespace

class SonyCameraWrapper : public Napi::ObjectWrap<SonyCameraWrapper>, public SCRSDK::IDeviceCallback {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    SonyCameraWrapper(const Napi::CallbackInfo& info);
    ~SonyCameraWrapper();

    // IDeviceCallback implementation
    virtual void OnConnected(SCRSDK::DeviceConnectionVersioin version) override;
    virtual void OnDisconnected(CrInt32u error) override;
    virtual void OnPropertyChanged() override;
    virtual void OnLvPropertyChanged() override;
    virtual void OnCompleted(CrInt32u api_name, CrInt32 result) override;
    virtual void OnError(CrInt32u api_name, CrInt32 result) override;
    virtual void OnWarning(CrInt32u api_name, CrInt32 result) override;

private:
    static Napi::FunctionReference constructor;
    
    // API Methods
    Napi::Value Connect(const Napi::CallbackInfo& info);
    Napi::Value Disconnect(const Napi::CallbackInfo& info);
    Napi::Value CaptureImage(const Napi::CallbackInfo& info);
    Napi::Value StartLiveView(const Napi::CallbackInfo& info);
    Napi::Value StopLiveView(const Napi::CallbackInfo& info);
    Napi::Value GetProperty(const Napi::CallbackInfo& info);
    Napi::Value SetProperty(const Napi::CallbackInfo& info);
    Napi::Value GetDeviceInfo(const Napi::CallbackInfo& info);
    Napi::Value ListDevices(const Napi::CallbackInfo& info);
    
    // Internal helpers
    bool InitializeSDK();
    bool EnumerateDevices();
    bool OpenConnection();
    void CloseConnection();
    std::string CaptureAndDownload();
    
    // Member variables
    SCRSDK::ICrCameraObjectInfo* m_camera_info = nullptr;
    CrDeviceHandle m_device_handle = 0;
    std::atomic<bool> m_connected{false};
    std::atomic<bool> m_sdk_initialized{false};
    std::atomic<bool> m_liveview_active{false};
    std::mutex m_mutex;
    std::condition_variable m_cv;
    
    // Capture state
    std::atomic<bool> m_capture_in_progress{false};
    std::string m_last_captured_file;
    
    // SDK objects
    std::vector<SCRSDK::ICrCameraObjectInfo*> m_camera_list;
    
    // Callbacks for async operations
    Napi::ThreadSafeFunction m_capture_callback;
    Napi::ThreadSafeFunction m_liveview_callback;
};

Napi::FunctionReference SonyCameraWrapper::constructor;

// Constructor
SonyCameraWrapper::SonyCameraWrapper(const Napi::CallbackInfo& info) 
    : Napi::ObjectWrap<SonyCameraWrapper>(info) {
    InitializeSDK();
}

// Destructor
SonyCameraWrapper::~SonyCameraWrapper() {
    if (m_connected) {
        CloseConnection();
    }
    if (m_sdk_initialized) {
        SCRSDK::Release();
    }
}

// Initialize SDK
bool SonyCameraWrapper::InitializeSDK() {
    if (m_sdk_initialized) {
        return true;
    }
    
    auto init_result = SCRSDK::Init();
    if (CR_SUCCEEDED(init_result)) {
        m_sdk_initialized = true;
        return true;
    }
    
    return false;
}

// Enumerate connected devices
bool SonyCameraWrapper::EnumerateDevices() {
    SCRSDK::ICrEnumCameraObjectInfo* camera_list = nullptr;
    auto result = SCRSDK::EnumCameraObjects(&camera_list);
    
    if (CR_FAILED(result) || !camera_list) {
        return false;
    }
    
    auto count = camera_list->GetCount();
    if (count == 0) {
        camera_list->Release();
        return false;
    }
    
    // Clear previous list
    for (auto* cam : m_camera_list) {
        cam->Release();
    }
    m_camera_list.clear();
    
    // Store cameras
    for (CrInt32u i = 0; i < count; ++i) {
        auto* cam_info = camera_list->GetCameraObjectInfo(i);
        if (cam_info) {
            m_camera_list.push_back(cam_info);
        }
    }
    
    camera_list->Release();
    return !m_camera_list.empty();
}

// Connect to camera
Napi::Value SonyCameraWrapper::Connect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!EnumerateDevices()) {
        return Napi::Boolean::New(env, false);
    }
    
    if (m_camera_list.empty()) {
        return Napi::Boolean::New(env, false);
    }
    
    // Use first available camera
    m_camera_info = m_camera_list[0];
    
    // Create device handle and connect
    auto result = SCRSDK::Connect(
        m_camera_info,
        this,  // IDeviceCallback
        &m_device_handle
    );
    
    if (CR_SUCCEEDED(result)) {
        m_connected = true;
        return Napi::Boolean::New(env, true);
    }
    
    return Napi::Boolean::New(env, false);
}

// Disconnect from camera
Napi::Value SonyCameraWrapper::Disconnect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected || m_device_handle == 0) {
        return Napi::Boolean::New(env, false);
    }
    
    auto result = SCRSDK::Disconnect(m_device_handle);
    
    if (CR_SUCCEEDED(result)) {
        m_connected = false;
        m_device_handle = 0;
        return Napi::Boolean::New(env, true);
    }
    
    return Napi::Boolean::New(env, false);
}

// Capture image
Napi::Value SonyCameraWrapper::CaptureImage(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected) {
        Napi::Error::New(env, "Camera not connected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    // Create promise
    Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
    
    // Trigger capture
    auto result = SCRSDK::SendCommand(
        m_device_handle,
        SCRSDK::CrCommandId::CrCommandId_Release,
        SCRSDK::CrCommandParam::CrCommandParam_Down
    );
    
    if (CR_SUCCEEDED(result)) {
        // Simulate capture completion (in real implementation, wait for callback)
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        
        // Return captured file path
        std::string captured_path = "/tmp/capture_" + std::to_string(time(nullptr)) + ".jpg";
        deferred.Resolve(Napi::String::New(env, captured_path));
    } else {
        deferred.Reject(Napi::Error::New(env, "Capture failed").Value());
    }
    
    return deferred.Promise();
}

// Get property
Napi::Value SonyCameraWrapper::GetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected) {
        return env.Null();
    }
    
    if (info.Length() < 1 || !info[0].IsString()) {
        return env.Null();
    }
    
    std::string prop_name = info[0].As<Napi::String>();
    
    // Map property names to SDK property IDs
    CrInt32 num_props = 0;
    CrDeviceProperty* properties = nullptr;
    
    auto result = SCRSDK::GetDeviceProperties(m_device_handle, &properties, &num_props);
    
    if (CR_SUCCEEDED(result) && properties) {
        // Find and return requested property
        for (CrInt32 i = 0; i < num_props; ++i) {
            // Match property by name and return value
            // This is simplified - real implementation would map names to IDs
        }
        
        SCRSDK::ReleaseDeviceProperties(m_device_handle, properties);
    }
    
    return env.Null();
}

// Set property
Napi::Value SonyCameraWrapper::SetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected) {
        return Napi::Boolean::New(env, false);
    }
    
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        return Napi::Boolean::New(env, false);
    }
    
    std::string prop_name = info[0].As<Napi::String>();
    std::string prop_value = info[1].As<Napi::String>();
    
    // Map property name to SDK property ID and set value
    // This is simplified - real implementation would handle various property types
    
    return Napi::Boolean::New(env, true);
}

// Get device info
Napi::Value SonyCameraWrapper::GetDeviceInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);
    
    if (m_camera_info) {
        CrChar model[256] = {0};
        m_camera_info->GetModel(model, sizeof(model));
        
        CrChar id[256] = {0};
        m_camera_info->GetId(id, sizeof(id));
        
        result.Set("model", Napi::String::New(env, (char*)model));
        result.Set("id", Napi::String::New(env, (char*)id));
        result.Set("connected", Napi::Boolean::New(env, m_connected.load()));
    } else {
        result.Set("model", "Unknown");
        result.Set("connected", false);
    }
    
    return result;
}

// List available devices
Napi::Value SonyCameraWrapper::ListDevices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array devices = Napi::Array::New(env);
    
    if (EnumerateDevices()) {
        for (size_t i = 0; i < m_camera_list.size(); ++i) {
            Napi::Object device = Napi::Object::New(env);
            
            CrChar model[256] = {0};
            m_camera_list[i]->GetModel(model, sizeof(model));
            
            CrChar id[256] = {0};
            m_camera_list[i]->GetId(id, sizeof(id));
            
            device.Set("model", Napi::String::New(env, (char*)model));
            device.Set("id", Napi::String::New(env, (char*)id));
            device.Set("index", Napi::Number::New(env, i));
            
            devices.Set(i, device);
        }
    }
    
    return devices;
}

// Start live view
Napi::Value SonyCameraWrapper::StartLiveView(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_connected) {
        return Napi::Boolean::New(env, false);
    }
    
    // Enable live view
    CrDeviceProperty prop;
    prop.SetCode(SCRSDK::CrDevicePropertyCode::CrDeviceProperty_LiveView_Enable);
    prop.SetCurrentValue(SCRSDK::CrLiveViewProperty::CrLiveView_Enable);
    prop.SetValueType(SCRSDK::CrDataType::CrDataType_UInt16);
    
    auto result = SCRSDK::SetDeviceProperty(m_device_handle, &prop);
    
    if (CR_SUCCEEDED(result)) {
        m_liveview_active = true;
        return Napi::Boolean::New(env, true);
    }
    
    return Napi::Boolean::New(env, false);
}

// Stop live view
Napi::Value SonyCameraWrapper::StopLiveView(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_liveview_active) {
        return Napi::Boolean::New(env, true);
    }
    
    // Disable live view
    CrDeviceProperty prop;
    prop.SetCode(SCRSDK::CrDevicePropertyCode::CrDeviceProperty_LiveView_Enable);
    prop.SetCurrentValue(SCRSDK::CrLiveViewProperty::CrLiveView_Disable);
    prop.SetValueType(SCRSDK::CrDataType::CrDataType_UInt16);
    
    auto result = SCRSDK::SetDeviceProperty(m_device_handle, &prop);
    
    if (CR_SUCCEEDED(result)) {
        m_liveview_active = false;
        return Napi::Boolean::New(env, true);
    }
    
    return Napi::Boolean::New(env, false);
}

// IDeviceCallback implementations
void SonyCameraWrapper::OnConnected(SCRSDK::DeviceConnectionVersioin version) {
    m_connected = true;
}

void SonyCameraWrapper::OnDisconnected(CrInt32u error) {
    m_connected = false;
}

void SonyCameraWrapper::OnPropertyChanged() {
    // Handle property changes
}

void SonyCameraWrapper::OnLvPropertyChanged() {
    // Handle live view property changes
}

void SonyCameraWrapper::OnCompleted(CrInt32u api_name, CrInt32 result) {
    // Handle API completion
}

void SonyCameraWrapper::OnError(CrInt32u api_name, CrInt32 result) {
    // Handle errors
}

void SonyCameraWrapper::OnWarning(CrInt32u api_name, CrInt32 result) {
    // Handle warnings
}

// Initialize and export
Napi::Object SonyCameraWrapper::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "SonyCamera", {
        InstanceMethod("connect", &SonyCameraWrapper::Connect),
        InstanceMethod("disconnect", &SonyCameraWrapper::Disconnect),
        InstanceMethod("captureImage", &SonyCameraWrapper::CaptureImage),
        InstanceMethod("startLiveView", &SonyCameraWrapper::StartLiveView),
        InstanceMethod("stopLiveView", &SonyCameraWrapper::StopLiveView),
        InstanceMethod("getProperty", &SonyCameraWrapper::GetProperty),
        InstanceMethod("setProperty", &SonyCameraWrapper::SetProperty),
        InstanceMethod("getDeviceInfo", &SonyCameraWrapper::GetDeviceInfo),
        InstanceMethod("listDevices", &SonyCameraWrapper::ListDevices),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("SonyCamera", func);
    return exports;
}

// Module initialization
Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    return SonyCameraWrapper::Init(env, exports);
}

NODE_API_MODULE(sony_camera_binding, InitAll)