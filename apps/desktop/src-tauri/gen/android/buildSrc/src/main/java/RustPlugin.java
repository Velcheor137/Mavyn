import com.android.build.api.dsl.ApplicationExtension;
import java.util.Arrays;
import java.util.List;
import org.gradle.api.DefaultTask;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.tasks.TaskProvider;

public class RustPlugin implements Plugin<Project> {
    private static List<String> values(Project project, String name, List<String> fallback) {
        Object value = project.findProperty(name);
        return value instanceof String ? Arrays.asList(((String) value).split(",")) : fallback;
    }
    private static String title(String value) { return Character.toUpperCase(value.charAt(0)) + value.substring(1); }
    @Override public void apply(Project project) {
        RustConfig config = project.getExtensions().create("rust", RustConfig.class);
        List<String> defaultAbis = List.of("arm64-v8a", "armeabi-v7a", "x86", "x86_64");
        List<String> defaultArches = List.of("arm64", "arm", "x86", "x86_64");
        List<String> abis = values(project, "abiList", defaultAbis);
        List<String> arches = values(project, "archList", defaultArches);
        List<String> targets = values(project, "targetList", List.of("aarch64", "armv7", "i686", "x86_64"));
        ApplicationExtension android = project.getExtensions().getByType(ApplicationExtension.class);
        android.getFlavorDimensions().add("abi");
        android.getProductFlavors().create("universal", flavor -> {
            flavor.setDimension("abi"); flavor.getNdk().getAbiFilters().addAll(abis);
        });
        for (int i = 0; i < defaultArches.size(); i++) {
            String abi = defaultAbis.get(i);
            android.getProductFlavors().create(defaultArches.get(i), flavor -> {
                flavor.setDimension("abi"); flavor.getNdk().getAbiFilters().add(abi);
            });
        }
        project.afterEvaluate(evaluated -> {
            for (String profile : List.of("debug", "release")) {
                String mode = title(profile);
                DefaultTask universal = project.getTasks().maybeCreate("rustBuildUniversal" + mode, DefaultTask.class);
                universal.setGroup("rust");
                universal.setDescription("Build dynamic library in " + profile + " mode for all targets");
                project.getTasks().getByName("mergeUniversal" + mode + "JniLibFolders").dependsOn(universal);
                for (int i = 0; i < targets.size(); i++) {
                    String arch = arches.get(i), target = targets.get(i);
                    TaskProvider<BuildTask> task = project.getTasks().register("rustBuild" + title(arch) + mode, BuildTask.class, build -> {
                        build.setGroup("rust");
                        build.setDescription("Build dynamic library in " + profile + " mode for " + arch);
                        build.setRootDirRel(config.getRootDirRel());
                        build.setProjectDir(project.getProjectDir().getPath());
                        build.setTarget(target); build.setRelease(profile.equals("release"));
                    });
                    universal.dependsOn(task);
                    project.getTasks().getByName("merge" + title(arch) + mode + "JniLibFolders").dependsOn(task);
                }
            }
        });
    }
}
