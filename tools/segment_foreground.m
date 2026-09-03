#import <CoreImage/CoreImage.h>
#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <Vision/Vision.h>

static void fail(NSString *message) {
  fprintf(stderr, "segment_foreground: %s\n", message.UTF8String);
  exit(1);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      fail(@"usage: segment_foreground <input-image> <output-png>");
    }

    NSURL *inputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    NSURL *outputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
    CIImage *sourceImage = [CIImage imageWithContentsOfURL:inputURL];
    if (sourceImage == nil) fail(@"could not read input image");

    NSError *error = nil;
    VNGenerateForegroundInstanceMaskRequest *request =
        [[VNGenerateForegroundInstanceMaskRequest alloc] init];
    NSDictionary<VNComputeStage, NSArray<id<MLComputeDeviceProtocol>> *> *supportedDevices =
        [request supportedComputeStageDevicesAndReturnError:&error];
    for (VNComputeStage stage in supportedDevices) {
      for (id<MLComputeDeviceProtocol> device in supportedDevices[stage]) {
        if ([device isKindOfClass:MLCPUComputeDevice.class]) {
          [request setComputeDevice:device forComputeStage:stage];
          break;
        }
      }
    }
    VNImageRequestHandler *handler =
        [[VNImageRequestHandler alloc] initWithURL:inputURL options:@{}];
    if (![handler performRequests:@[ request ] error:&error]) {
      fail(error.localizedDescription ?: @"Vision request failed");
    }

    VNInstanceMaskObservation *observation = request.results.firstObject;
    if (observation == nil || observation.allInstances.count == 0) {
      fail(@"Vision did not find a foreground subject");
    }

    CVPixelBufferRef maskBuffer =
        [observation generateScaledMaskForImageForInstances:observation.allInstances
                                         fromRequestHandler:handler
                                                      error:&error];
    if (maskBuffer == nil) {
      fail(error.localizedDescription ?: @"could not generate foreground mask");
    }

    CIImage *maskImage = [CIImage imageWithCVPixelBuffer:maskBuffer];
    CIImage *transparent =
        [[CIImage imageWithColor:[CIColor clearColor]] imageByCroppingToRect:sourceImage.extent];
    CIFilter *blend = [CIFilter filterWithName:@"CIBlendWithMask"];
    [blend setValue:sourceImage forKey:kCIInputImageKey];
    [blend setValue:transparent forKey:kCIInputBackgroundImageKey];
    [blend setValue:maskImage forKey:kCIInputMaskImageKey];
    CIImage *outputImage = blend.outputImage;
    if (outputImage == nil) fail(@"could not composite foreground");

    CIContext *context = [CIContext contextWithOptions:@{
      kCIContextCacheIntermediates : @NO,
      kCIContextUseSoftwareRenderer : @NO,
    }];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef outputCGImage =
        [context createCGImage:outputImage
                     fromRect:sourceImage.extent
                       format:kCIFormatRGBA8
                   colorSpace:colorSpace];
    CGColorSpaceRelease(colorSpace);
    CVPixelBufferRelease(maskBuffer);
    if (outputCGImage == nil) fail(@"could not render segmented image");

    [[NSFileManager defaultManager]
        createDirectoryAtURL:outputURL.URLByDeletingLastPathComponent
  withIntermediateDirectories:YES
                   attributes:nil
                        error:&error];
    if (error != nil) fail(error.localizedDescription);

    CGImageDestinationRef destination = CGImageDestinationCreateWithURL(
        (__bridge CFURLRef)outputURL,
        (__bridge CFStringRef)UTTypePNG.identifier,
        1,
        NULL);
    if (destination == nil) fail(@"could not create PNG destination");
    CGImageDestinationAddImage(destination, outputCGImage, NULL);
    BOOL finalized = CGImageDestinationFinalize(destination);
    CFRelease(destination);
    CGImageRelease(outputCGImage);
    if (!finalized) fail(@"could not write PNG");

    printf("segmented instances=%lu output=%s\n",
           (unsigned long)observation.allInstances.count,
           outputURL.path.UTF8String);
  }
  return 0;
}
