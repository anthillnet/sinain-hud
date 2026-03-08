#!/usr/bin/env ruby
require 'xcodeproj'

proj_path = File.join(__dir__, 'ios', 'ISinain.xcodeproj')
project = Xcodeproj::Project.open(proj_path)
target = project.targets.find { |t| t.name == 'ISinain' }

# Add SPM package reference for MWDAT SDK
pkg_ref = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
pkg_ref.repositoryURL = 'https://github.com/facebook/meta-wearables-dat-ios'
pkg_ref.requirement = { 'kind' => 'exactVersion', 'version' => '0.4.0' }
project.root_object.package_references << pkg_ref
puts "Added SPM package reference: meta-wearables-dat-ios v0.4.0"

# Add MWDATCore product dependency
core_dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
core_dep.product_name = 'MWDATCore'
core_dep.package = pkg_ref
target.package_product_dependencies << core_dep
puts "Added MWDATCore product dependency"

# Add MWDATCamera product dependency
camera_dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
camera_dep.product_name = 'MWDATCamera'
camera_dep.package = pkg_ref
target.package_product_dependencies << camera_dep
puts "Added MWDATCamera product dependency"

# Add to frameworks build phase
frameworks_phase = target.frameworks_build_phase

core_build = project.new(Xcodeproj::Project::Object::PBXBuildFile)
core_build.product_ref = core_dep
frameworks_phase.files << core_build
puts "Added MWDATCore to frameworks build phase"

camera_build = project.new(Xcodeproj::Project::Object::PBXBuildFile)
camera_build.product_ref = camera_dep
frameworks_phase.files << camera_build
puts "Added MWDATCamera to frameworks build phase"

project.save
puts "\nSPM dependencies added successfully!"
