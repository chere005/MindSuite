# Shared by ios-upload.sh and android-bundle.sh (sourced). POSIX sh.
# Resolves the app directory; the lanes reuse the generated ios/ and android/ projects.
store_app_dir() {
  case "$1" in
    CalMind) echo "CalMind/apps/app" ;;
    MealMind) echo "MealMind/app" ;;
    *) echo "unknown app '$1' (expected CalMind or MealMind)" >&2; return 1 ;;
  esac
}
