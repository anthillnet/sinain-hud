#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(WatchBridge, RCTEventEmitter)

RCT_EXTERN_METHOD(updateFeed:(NSArray *)messages
                  status:(NSDictionary *)status
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
