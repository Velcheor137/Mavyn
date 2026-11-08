import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import javax.inject.Inject;
import org.gradle.api.DefaultTask;
import org.gradle.api.GradleException;
import org.gradle.api.logging.LogLevel;
import org.gradle.api.tasks.Input;
import org.gradle.api.tasks.TaskAction;
import org.gradle.process.ExecOperations;

/** Plain Java keeps this small CLI bridge independent of Gradle's embedded Kotlin compiler. */
public abstract class BuildTask extends DefaultTask {
    private String rootDirRel;
    private String projectDir;
    private String target;
    private Boolean release;
    @Inject public abstract ExecOperations getExecOperations();
    @Input public String getRootDirRel() { return rootDirRel; }
    public void setRootDirRel(String value) { rootDirRel = value; }
    @Input public String getProjectDir() { return projectDir; }
    public void setProjectDir(String value) { projectDir = value; }
    @Input public String getTarget() { return target; }
    public void setTarget(String value) { target = value; }
    @Input public Boolean getRelease() { return release; }
    public void setRelease(Boolean value) { release = value; }

    @TaskAction public void assemble() {
        try { runTauriCli("npm"); }
        catch (RuntimeException initial) {
            if (!System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("windows")) throw initial;
            RuntimeException last = initial;
            for (String suffix : List.of(".exe", ".cmd", ".bat")) {
                try { runTauriCli("npm" + suffix); return; }
                catch (RuntimeException failure) { last = failure; }
            }
            throw last;
        }
    }

    private void runTauriCli(String executable) {
        if (rootDirRel == null || projectDir == null || target == null || release == null) {
            throw new GradleException("Rust build configuration is incomplete");
        }
        List<String> args = new ArrayList<>(List.of("run", "tauri", "--", "android", "android-studio-script"));
        if (getLogger().isEnabled(LogLevel.DEBUG)) args.add("-vv");
        else if (getLogger().isEnabled(LogLevel.INFO)) args.add("-v");
        if (release) args.add("--release");
        args.add("--target"); args.add(target);
        getExecOperations().exec(spec -> {
            spec.setWorkingDir(new File(projectDir, rootDirRel));
            spec.setExecutable(executable);
            spec.args(args);
        }).assertNormalExitValue();
    }
}
