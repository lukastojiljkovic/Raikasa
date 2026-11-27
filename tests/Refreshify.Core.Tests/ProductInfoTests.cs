using System.Reflection;

namespace Refreshify.Core.Tests;

public class ProductInfoTests
{
    [Fact]
    public void Name_is_the_product_the_build_stamps_into_the_assemblies()
    {
        var product = typeof(ProductInfo).Assembly.GetCustomAttribute<AssemblyProductAttribute>()?.Product;

        Assert.Equal(ProductInfo.Name, product);
    }

    [Fact]
    public void Assemblies_are_named_after_the_product()
    {
        Assert.Equal($"{ProductInfo.Name}.Core", typeof(ProductInfo).Assembly.GetName().Name);
        Assert.Equal($"{ProductInfo.Name}.Core.Tests", typeof(ProductInfoTests).Assembly.GetName().Name);
    }

    [Fact]
    public void Ids_are_spelled_from_the_name()
    {
        Assert.Equal(ProductInfo.Id, ProductInfo.Name.ToLowerInvariant());
        Assert.Equal(ProductInfo.EnvironmentPrefix, ProductInfo.Name.ToUpperInvariant() + "_");
        Assert.Equal(ProductInfo.Id, ProductInfo.Scheme);
        Assert.Equal($"{ProductInfo.Name} reminder-", ProductInfo.TaskNamePrefix);
        Assert.EndsWith($".{ProductInfo.Name}", ProductInfo.AppUserModelId, StringComparison.Ordinal);
    }

    [Fact]
    public void The_repository_is_the_owner_and_the_name()
    {
        Assert.Equal($"https://github.com/{ProductInfo.RepositoryOwner}/{ProductInfo.RepositoryName}", ProductInfo.RepositoryUrl);
    }
}
