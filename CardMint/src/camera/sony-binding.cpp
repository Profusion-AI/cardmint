#include <napi.h>
#include <memory>
#include <vector>
#include <string>
#include "camera-wrapper.h"

class SonyCameraBinding : public Napi::ObjectWrap<SonyCameraBinding> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    SonyCameraBinding(const Napi::CallbackInfo& info);
    ~SonyCameraBinding();

private:
    static Napi::FunctionReference constructor;
    std::unique_ptr<CameraWrapper> camera;
    
    Napi::Value Connect(const Napi::CallbackInfo& info);
    Napi::Value Disconnect(const Napi::CallbackInfo& info);
    Napi::Value CaptureImage(const Napi::CallbackInfo& info);
    Napi::Value StartLiveView(const Napi::CallbackInfo& info);
    Napi::Value StopLiveView(const Napi::CallbackInfo& info);
    Napi::Value GetProperty(const Napi::CallbackInfo& info);
    Napi::Value SetProperty(const Napi::CallbackInfo& info);
    Napi::Value GetDeviceInfo(const Napi::CallbackInfo& info);
    Napi::Value ListDevices(const Napi::CallbackInfo& info);
};

Napi::FunctionReference SonyCameraBinding::constructor;

Napi::Object SonyCameraBinding::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);
    
    Napi::Function func = DefineClass(env, "SonyCamera", {
        InstanceMethod("connect", &SonyCameraBinding::Connect),
        InstanceMethod("disconnect", &SonyCameraBinding::Disconnect),
        InstanceMethod("captureImage", &SonyCameraBinding::CaptureImage),
        InstanceMethod("startLiveView", &SonyCameraBinding::StartLiveView),
        InstanceMethod("stopLiveView", &SonyCameraBinding::StopLiveView),
        InstanceMethod("getProperty", &SonyCameraBinding::GetProperty),
        InstanceMethod("setProperty", &SonyCameraBinding::SetProperty),
        InstanceMethod("getDeviceInfo", &SonyCameraBinding::GetDeviceInfo),
        InstanceMethod("listDevices", &SonyCameraBinding::ListDevices),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("SonyCamera", func);
    return exports;
}

SonyCameraBinding::SonyCameraBinding(const Napi::CallbackInfo& info) 
    : Napi::ObjectWrap<SonyCameraBinding>(info) {
    Napi::Env env = info.Env();
    camera = std::make_unique<CameraWrapper>();
}

SonyCameraBinding::~SonyCameraBinding() {
    if (camera) {
        camera->Disconnect();
    }
}

Napi::Value SonyCameraBinding::Connect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Object expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Object options = info[0].As<Napi::Object>();
    std::string connectionType = options.Get("type").As<Napi::String>();
    
    bool result = false;
    
    if (connectionType == "USB") {
        std::string deviceId = options.Get("deviceId").As<Napi::String>();
        result = camera->ConnectUSB(deviceId);
    } else if (connectionType == "ETHERNET") {
        std::string ipAddress = options.Get("ip").As<Napi::String>();
        result = camera->ConnectEthernet(ipAddress);
    }
    
    return Napi::Boolean::New(env, result);
}

Napi::Value SonyCameraBinding::Disconnect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    bool result = camera->Disconnect();
    return Napi::Boolean::New(env, result);
}

Napi::Value SonyCameraBinding::CaptureImage(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
    
    camera->CaptureImageAsync([deferred, env](bool success, const std::string& imagePath) {
        Napi::HandleScope scope(env);
        
        if (success) {
            deferred.Resolve(Napi::String::New(env, imagePath));
        } else {
            deferred.Reject(Napi::String::New(env, "Capture failed"));
        }
    });
    
    return deferred.Promise();
}

Napi::Value SonyCameraBinding::StartLiveView(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Callback function expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Function callback = info[0].As<Napi::Function>();
    
    bool result = camera->StartLiveView([callback, env](const uint8_t* data, size_t size) {
        Napi::HandleScope scope(env);
        
        Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(env, data, size);
        callback.Call({buffer});
    });
    
    return Napi::Boolean::New(env, result);
}

Napi::Value SonyCameraBinding::StopLiveView(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    bool result = camera->StopLiveView();
    return Napi::Boolean::New(env, result);
}

Napi::Value SonyCameraBinding::GetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Property name expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string propertyName = info[0].As<Napi::String>();
    auto value = camera->GetProperty(propertyName);
    
    if (value.has_value()) {
        return Napi::String::New(env, value.value());
    }
    
    return env.Null();
}

Napi::Value SonyCameraBinding::SetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 2 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Property name and value expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string propertyName = info[0].As<Napi::String>();
    std::string propertyValue = info[1].As<Napi::String>();
    
    bool result = camera->SetProperty(propertyName, propertyValue);
    return Napi::Boolean::New(env, result);
}

Napi::Value SonyCameraBinding::GetDeviceInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    auto deviceInfo = camera->GetDeviceInfo();
    
    Napi::Object result = Napi::Object::New(env);
    result.Set("model", deviceInfo.model);
    result.Set("serialNumber", deviceInfo.serialNumber);
    result.Set("firmware", deviceInfo.firmware);
    result.Set("connected", deviceInfo.connected);
    
    return result;
}

Napi::Value SonyCameraBinding::ListDevices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    auto devices = camera->ListAvailableDevices();
    
    Napi::Array result = Napi::Array::New(env, devices.size());
    
    for (size_t i = 0; i < devices.size(); i++) {
        Napi::Object device = Napi::Object::New(env);
        device.Set("id", devices[i].id);
        device.Set("name", devices[i].name);
        device.Set("type", devices[i].type);
        result[i] = device;
    }
    
    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return SonyCameraBinding::Init(env, exports);
}

NODE_API_MODULE(sony_camera_binding, Init)