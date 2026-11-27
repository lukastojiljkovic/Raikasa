using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace Raikasa.Models;

public abstract class Observable : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>Without a name, every binding to this object updates, which suits models whose properties are all derived.</summary>
    protected void Changed([CallerMemberName] string name = "") => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
