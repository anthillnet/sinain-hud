#!/usr/bin/env ruby
require 'xcodeproj'

proj_path = File.join(__dir__, 'ios', 'ISinain.xcodeproj')
project = Xcodeproj::Project.open(proj_path)

# Find the main target
target = project.targets.find { |t| t.name == 'ISinain' }
raise "Target ISinain not found" unless target

# Get or create groups
main_group = project.main_group.find_subpath('ISinain', false)
raise "ISinain group not found in project" unless main_group

def find_or_create_group(parent, name)
  existing = parent.children.find { |c| c.is_a?(Xcodeproj::Project::Object::PBXGroup) && c.name == name }
  existing || parent.new_group(name)
end

bridge_group = find_or_create_group(main_group, 'Bridge')
pipeline_group = find_or_create_group(main_group, 'Pipeline')
config_group = find_or_create_group(main_group, 'Config')
infra_group = find_or_create_group(main_group, 'Infra')

# Helper to add a file to group + target
def add_file(group, path, target)
  # Check if already added
  name = File.basename(path)
  existing = group.children.find { |c| c.respond_to?(:name) && c.name == name }
  return if existing

  ref = group.new_file(path)

  ext = File.extname(path)
  if ['.swift', '.m'].include?(ext)
    target.source_build_phase.add_file_reference(ref)
  elsif ['.caf', '.wav', '.mp3'].include?(ext)
    # Add to resources
    target.resources_build_phase.add_file_reference(ref)
  end
  puts "  Added: #{name}"
end

ios_dir = File.join(__dir__, 'ios', 'ISinain')

# Bridge files
puts "Adding Bridge files..."
%w[WearablesBridge.swift WearablesBridge.m WatchBridge.swift WatchBridge.m].each do |f|
  add_file(bridge_group, File.join(ios_dir, 'Bridge', f), target)
end

# Pipeline files
puts "Adding Pipeline files..."
%w[Protocols.swift FrameAnalyzer.swift SceneGate.swift VisionClient.swift ObservationBuilder.swift GatewayClient.swift PipelineOrchestrator.swift].each do |f|
  add_file(pipeline_group, File.join(ios_dir, 'Pipeline', f), target)
end

# Config files
puts "Adding Config files..."
%w[PipelineConfig.swift].each do |f|
  add_file(config_group, File.join(ios_dir, 'Config', f), target)
end

# Infra files
puts "Adding Infra files..."
%w[BackgroundKeepAlive.swift Logger.swift].each do |f|
  add_file(infra_group, File.join(ios_dir, 'Infra', f), target)
end

# silence.caf
puts "Adding silence.caf..."
add_file(main_group, File.join(ios_dir, 'silence.caf'), target)

# Bridging header
puts "Adding bridging header..."
header_ref = main_group.children.find { |c| c.respond_to?(:name) && c.name == 'ISinain-Bridging-Header.h' }
unless header_ref
  header_ref = main_group.new_file(File.join(ios_dir, 'ISinain-Bridging-Header.h'))
  puts "  Added: ISinain-Bridging-Header.h"
end

# Set bridging header in build settings
target.build_configurations.each do |config|
  config.build_settings['SWIFT_OBJC_BRIDGING_HEADER'] = 'ISinain/ISinain-Bridging-Header.h'
end
puts "Set bridging header build setting"

# Disable New Architecture
target.build_configurations.each do |config|
  config.build_settings['RCT_NEW_ARCH_ENABLED'] = 'NO'
end
puts "Disabled New Architecture"

# Save
project.save
puts "\nXcode project updated successfully!"
puts "Files in project:"
project.files.each { |f| puts "  #{f.path}" if f.path }
